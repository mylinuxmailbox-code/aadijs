/**
 * Strato installer: orchestrates resolve → layout → fetch/verify/store → link → bins → scripts → lockfile.
 * Incremental: a state file records what is already materialized so unchanged packages are skipped.
 */
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { c, fmtMs, limiter, log, spinner } from "../../utils/src/index.ts";
import { Registry, readNpmrc } from "./registry.ts";
import { gitCacheDir, layout, resolveGraph, type Graph, type LockEntry, type Lockfile, type Resolved, type Workspace } from "./resolver.ts";
import { addToStore, defaultLinkMode, hasInStore, linkTree, pruneStore, storePath, touchStore, verifyIntegrity, type LinkMode } from "./store.ts";
import { STRATO_HOME } from "./registry.ts";

export const LOCKFILE = "strato.lock";

export interface InstallOptions {
  cwd: string;
  frozen?: boolean;
  offline?: boolean;
  preferOffline?: boolean;
  production?: boolean;
  ignoreScripts?: boolean;
  allowScripts?: boolean;
  refresh?: Set<string> | "all";
  linkMode?: LinkMode;
  dryRun?: boolean;
}

export interface InstallStats {
  packages: number; added: number; removed: number; reused: number; downloaded: number; storeHits: number;
  bytes: number; metaRequests: number; metaCacheHits: number;
  timings: { resolve: number; fetchLink: number; scripts: number; total: number };
  blockedScripts: string[];
  warnings: string[];
}

export function readPkg(cwd: string): any {
  const p = join(cwd, "package.json");
  if (!existsSync(p)) throw Object.assign(new Error(`No package.json in ${cwd}`), { hint: "Run `strato init` to create one." });
  return JSON.parse(readFileSync(p, "utf8"));
}
export function writePkg(cwd: string, pkg: any) {
  writeFileSync(join(cwd, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}

export function readLock(cwd: string): Lockfile | undefined {
  const p = join(cwd, LOCKFILE);
  if (!existsSync(p)) return undefined;
  const l = JSON.parse(readFileSync(p, "utf8"));
  if (l.lockfileVersion !== 1) throw new Error(`Unsupported ${LOCKFILE} version ${l.lockfileVersion}`);
  return l;
}

export function findWorkspaces(cwd: string, pkg: any): Map<string, Workspace> {
  const out = new Map<string, Workspace>();
  const patterns: string[] = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
  for (const pat of patterns) {
    for (const f of new Bun.Glob(pat.replace(/\/$/, "") + "/package.json").scanSync({ cwd, onlyFiles: true })) {
      if (f.includes("node_modules")) continue;
      const dir = resolve(cwd, dirname(f));
      const wp = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (!wp.name) continue;
      out.set(wp.name, { name: wp.name, version: wp.version ?? "0.0.0", dir, pkg: wp });
    }
  }
  return out;
}

/** Collect the root dependency set (root deps + all workspaces, dev deps unless production). */
export function rootDependencies(pkg: any, workspaces: Map<string, Workspace>, production = false) {
  const deps: Record<string, string> = { ...(production ? {} : pkg.devDependencies), ...pkg.optionalDependencies, ...pkg.dependencies };
  for (const ws of workspaces.values()) deps[ws.name] = "workspace:*";
  return deps;
}

export async function install(o: InstallOptions): Promise<InstallStats> {
  const t0 = performance.now();
  const cwd = resolve(o.cwd);
  const pkg = readPkg(cwd);
  const workspaces = findWorkspaces(cwd, pkg);
  const lock = readLock(cwd);
  const rootDeps = rootDependencies(pkg, workspaces, false);
  const registry = new Registry(readNpmrc(cwd), o.offline, o.preferOffline);
  const stats: InstallStats = { packages: 0, added: 0, removed: 0, reused: 0, downloaded: 0, storeHits: 0, bytes: 0, metaRequests: 0, metaCacheHits: 0, timings: { resolve: 0, fetchLink: 0, scripts: 0, total: 0 }, blockedScripts: [], warnings: [] };

  // Workspace deps are part of the graph via the workspace nodes' own dependencies (plus devDeps for local dev).
  for (const ws of workspaces.values()) ws.pkg.dependencies = { ...(o.production ? {} : ws.pkg.devDependencies), ...ws.pkg.dependencies };
  // Lockfile signature covers root deps and every workspace's deps.
  const sigDeps: Record<string, string> = { ...rootDeps };
  for (const ws of workspaces.values()) for (const [d, s] of Object.entries(ws.pkg.dependencies as Record<string, string>)) sigDeps[`${ws.name}>${d}`] = s;
  const ov = flatOverrides(pkg);
  if (ov) for (const [k, v] of Object.entries(ov)) sigDeps[`overrides>${k}`] = v;

  const lockMatches = !!lock && sameDeps(lock.root.dependencies, sigDeps);
  if (o.frozen && !lockMatches) {
    throw Object.assign(new Error(`${LOCKFILE} is ${lock ? "out of date with package.json" : "missing"} (frozen lockfile)`), { hint: "Run `strato install` locally and commit the lockfile." });
  }

  const sp = spinner("Resolving dependencies…");
  let tree: Map<string, Resolved>;
  let graph: Graph | undefined;
  const tr = performance.now();
  if (lockMatches && !o.refresh) {
    tree = new Map();
    for (const [p, e] of Object.entries(lock!.packages)) tree.set(p, entryToResolved(e, cwd, workspaces));
  } else {
    graph = await resolveGraph(rootDeps, {
      root: cwd, registry, lock, refresh: o.refresh, overrides: flatOverrides(pkg), workspaces,
      onProgress: (n) => sp.update(`Resolving dependencies… ${c.dim(String(n))}`),
    });
    const placed = layout(graph);
    tree = new Map([...placed].map(([p, id]) => [p, graph!.nodes.get(id)!]));
    stats.warnings.push(...graph.optionalSkipped.map((s) => `optional dependency skipped: ${s}`));
  }
  stats.timings.resolve = performance.now() - tr;

  // Determine dev-only packages for --production pruning.
  const devOnly = o.production ? computeDevOnly(tree, pkg, workspaces) : new Set<string>();
  const finalTree = new Map([...tree].filter(([p]) => !devOnly.has(p)));
  stats.packages = finalTree.size;

  if (o.dryRun) {
    sp.stop();
    stats.timings.total = performance.now() - t0;
    return stats;
  }

  // Incremental state
  const nm = join(cwd, "node_modules");
  const stateFile = join(nm, ".strato", "state.json");
  const prev: Record<string, string> = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
  const next: Record<string, string> = {};
  const sig = (r: Resolved) => `${r.kind}|${r.version}|${r.integrity ?? r.resolved}`;

  // Remove extraneous packages (deepest first)
  for (const p of Object.keys(prev).sort((a, b) => b.length - a.length)) {
    const r = finalTree.get(p);
    if (!r || sig(r) !== prev[p]) { rmSync(join(cwd, p), { recursive: true, force: true }); if (!r) stats.removed++; }
  }

  const tf = performance.now();
  const mode = o.linkMode ?? defaultLinkMode();
  const io = limiter(Number(process.env.STRATO_IO_CONCURRENCY ?? 32));
  let done = 0;
  sp.update(`Installing ${finalTree.size} packages…`);
  await Promise.all([...finalTree].map(async ([p, r]) => {
    const dest = join(cwd, p);
    next[p] = sig(r);
    if (prev[p] === next[p] && existsSync(join(dest, "package.json"))) { stats.reused++; done++; return; }
    if (r.kind === "link" || r.kind === "workspace") {
      const target = resolve(cwd, r.resolved);
      mkdirSync(dirname(dest), { recursive: true });
      rmSync(dest, { recursive: true, force: true });
      symlinkSync(relative(dirname(dest), target), dest, process.platform === "win32" ? "junction" : "dir");
    } else if (r.kind === "git") {
      const dir = r.dir ?? gitCacheLookup(r);
      await io(async () => linkTree(dir, dest, mode));
    } else {
      let src: string;
      if (r.integrity && hasInStore(r.integrity)) { src = storePath(r.integrity.split(/\s+/)[0]!); stats.storeHits++; }
      else {
        const buf = await registry.tarball(r.resolved);
        let integrity: string;
        try { integrity = verifyIntegrity(buf, r.integrity); }
        catch (e) { throw new Error(`${r.name}@${r.version}: ${(e as Error).message}. Refusing to install a tampered package.`); }
        src = addToStore(buf, r.integrity?.split(/\s+/)[0] ?? integrity);
        stats.downloaded++;
      }
      touchStore(src);
      await io(async () => linkTree(src, dest, mode));
    }
    stats.added++;
    done++;
    if (done % 25 === 0) sp.update(`Installing… ${done}/${finalTree.size}`);
  }));
  stats.timings.fetchLink = performance.now() - tf;

  // Bins
  for (const [p, r] of finalTree) linkBins(cwd, p, r);

  sp.stop();
  // Lifecycle scripts (security: only trusted packages run scripts)
  const ts = performance.now();
  const trusted = new Set<string>(pkg.trustedDependencies ?? []);
  const withScripts = [...finalTree].filter(([p, r]) => r.hasInstallScript || hasLifecycle(join(cwd, p))).sort((a, b) => b[0].length - a[0].length);
  for (const [p, r] of withScripts) {
    if (prev[p] === next[p]) continue;
    if (o.ignoreScripts || (!o.allowScripts && !trusted.has(r.name))) { stats.blockedScripts.push(r.name); continue; }
    await runLifecycle(join(cwd, p), cwd, r.name);
  }
  if (!o.ignoreScripts) for (const s of ["preinstall", "install", "postinstall", "prepare"]) if (pkg.scripts?.[s]) await runScript(cwd, s, pkg.scripts[s], cwd);
  stats.timings.scripts = performance.now() - ts;

  // Persist lockfile + state
  if (!lockMatches || o.refresh || !lock) {
    const newLock: Lockfile = { lockfileVersion: 1, root: { dependencies: sortObj(sigDeps) }, packages: {} };
    for (const [p, r] of tree) newLock.packages[p] = resolvedToEntry(r);
    writeFileSync(join(cwd, LOCKFILE), JSON.stringify(newLock, null, 2) + "\n");
  }
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(next));

  Object.assign(stats, { bytes: registry.stats.tarballBytes, metaRequests: registry.stats.metaRequests, metaCacheHits: registry.stats.metaCacheHits });
  stats.timings.total = performance.now() - t0;
  writeFileSync(join(nm, ".strato", "last-install.json"), JSON.stringify({ at: new Date().toISOString(), ...stats }, null, 2));
  autoPrune();
  return stats;
}

function gitCacheLookup(r: Resolved): string {
  throw new Error(`git dependency ${r.name} must be re-resolved (run \`strato install\` without a frozen lockfile)`);
}

function entryToResolved(e: LockEntry, cwd: string, ws: Map<string, Workspace>): Resolved {
  const { optional, dev, ...rest } = e;
  const r: Resolved = { ...rest, id: `${e.name}@${e.version}`, dependencies: e.dependencies ?? {} };
  if (e.kind === "git") {
    const cand = gitCacheDir(e.resolved);
    if (existsSync(cand)) r.dir = cand;
  }
  if (e.kind === "workspace" && ws.has(e.name)) r.dir = ws.get(e.name)!.dir;
  return r;
}

function resolvedToEntry(r: Resolved): LockEntry {
  const e: any = { name: r.name, version: r.version, kind: r.kind, resolved: r.resolved };
  if (r.integrity) e.integrity = r.integrity;
  if (Object.keys(r.dependencies).length) e.dependencies = sortObj(r.dependencies);
  if (r.optionalDependencies) e.optionalDependencies = r.optionalDependencies;
  if (r.peerDependencies) e.peerDependencies = r.peerDependencies;
  if (r.bin) e.bin = r.bin;
  if (r.hasInstallScript) e.hasInstallScript = true;
  if (r.os) e.os = r.os;
  if (r.cpu) e.cpu = r.cpu;
  return e;
}

function computeDevOnly(tree: Map<string, Resolved>, pkg: any, ws: Map<string, Workspace>): Set<string> {
  // Walk from production roots, following node resolution, mark reachable; everything else is dev-only.
  const reachable = new Set<string>();
  const find = (from: string, name: string): string | undefined => {
    let L: string | null = from;
    while (L !== null) {
      const p = L ? `${L}/node_modules/${name}` : `node_modules/${name}`;
      if (tree.has(p)) return p;
      const i = L.lastIndexOf("/node_modules/");
      L = i < 0 ? (L ? "" : null) : L.slice(0, i);
    }
  };
  const stack: string[] = [];
  for (const n of [...Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }), ...ws.keys()]) { const p = find("", n); if (p) stack.push(p); }
  while (stack.length) {
    const p = stack.pop()!;
    if (reachable.has(p)) continue;
    reachable.add(p);
    const r = tree.get(p)!;
    for (const n of Object.keys({ ...r.dependencies, ...r.optionalDependencies, ...r.peerDependencies })) { const q = find(p, n); if (q) stack.push(q); }
  }
  return new Set([...tree.keys()].filter((p) => !reachable.has(p)));
}

function linkBins(cwd: string, p: string, r: Resolved) {
  let bins = r.bin;
  const pkgDir = join(cwd, p);
  if (!bins && r.kind !== "registry") return;
  if (!bins) return;
  const binDir = join(cwd, dirname(p), ".bin");
  mkdirSync(binDir, { recursive: true });
  for (const [name, rel] of Object.entries(bins)) {
    if (!/^[\w@.\-/]+$/.test(name) || name.includes("..")) continue; // reject path traversal in bin names
    const target = join(pkgDir, rel);
    if (!target.startsWith(pkgDir)) continue;
    const link = join(binDir, name.includes("/") ? name.split("/").pop()! : name);
    try { lstatSync(link); rmSync(link, { force: true }); } catch {}
    try {
      if (process.platform === "win32") writeFileSync(link + ".cmd", `@bun "${target}" %*\r\n`);
      else { symlinkSync(relative(binDir, target), link); if (existsSync(target)) chmodSync(target, 0o755); }
    } catch (e) { log.debug(`bin link failed for ${name}: ${(e as Error).message}`); }
  }
}

function hasLifecycle(dir: string) {
  try {
    const s = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts ?? {};
    return !!(s.preinstall || s.install || s.postinstall);
  } catch { return false; }
}

async function runLifecycle(dir: string, root: string, name: string) {
  const scripts = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts ?? {};
  for (const s of ["preinstall", "install", "postinstall"]) if (scripts[s]) {
    log.info(c.dim(`  ${name} › ${s}: ${scripts[s]}`));
    await runScript(dir, s, scripts[s], root);
  }
}

export async function runScript(dir: string, name: string, cmd: string, root: string, extraArgs: string[] = []) {
  const PATH = [join(dir, "node_modules", ".bin"), join(root, "node_modules", ".bin"), process.env.PATH].join(process.platform === "win32" ? ";" : ":");
  const full = extraArgs.length ? `${cmd} ${extraArgs.map((a) => JSON.stringify(a)).join(" ")}` : cmd;
  const shell = process.platform === "win32" ? ["cmd", "/d", "/s", "/c", full] : ["sh", "-c", full];
  const p = Bun.spawn(shell, { cwd: dir, env: { ...process.env, PATH, npm_lifecycle_event: name, npm_package_json: join(dir, "package.json") }, stdio: ["inherit", "inherit", "inherit"] });
  const code = await p.exited;
  if (code !== 0) throw Object.assign(new Error(`Script "${name}" failed with exit code ${code} in ${relative(root, dir) || "."}`), { exitCode: code });
}

function flatOverrides(pkg: any): Record<string, string> | undefined {
  const o = { ...pkg.resolutions, ...pkg.overrides };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (typeof v === "string") out[k.replace(/^\*\*\//, "")] = v;
  return Object.keys(out).length ? out : undefined;
}

const sortObj = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
function sameDeps(a: Record<string, string>, b: Record<string, string>) {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

function autoPrune() {
  const marker = join(STRATO_HOME, ".last-prune");
  try {
    const last = existsSync(marker) ? Number(readFileSync(marker, "utf8")) : 0;
    if (Date.now() - last < 7 * 86400_000) return;
    writeFileSync(marker, String(Date.now()));
    const { removed } = pruneStore(Number(process.env.STRATO_CACHE_MAX_AGE_DAYS ?? 60));
    if (removed) log.debug(`auto-pruned ${removed} unused store entries`);
  } catch (e) { log.debug(`auto-prune skipped: ${(e as Error).message}`); }
}

export function printStats(s: InstallStats) {
  for (const w of s.warnings) log.warn(w);
  if (s.blockedScripts.length)
    log.warn(`Blocked lifecycle scripts for: ${[...new Set(s.blockedScripts)].join(", ")}\n  Add them to "trustedDependencies" in package.json or pass --allow-scripts.`);
  log.info(
    `${c.green("✓")} ${c.bold(String(s.packages))} packages ${c.dim("in")} ${c.cyan(fmtMs(s.timings.total))}` +
    c.dim(`  (+${s.added} −${s.removed} ↺${s.reused} · ${s.downloaded} downloaded · ${s.storeHits} from store · resolve ${fmtMs(s.timings.resolve)} · link ${fmtMs(s.timings.fetchLink)})`),
  );
}

export { readdirSync };
