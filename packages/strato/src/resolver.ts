/**
 * Strato resolver.
 * Phase 1 — concurrent graph resolution: every (name, spec) edge is resolved in parallel, packuments
 *           are fetched at most once, and lockfile entries are reused as manifests (zero network
 *           for unchanged dependencies).
 * Phase 2 — deterministic hoisted layout (npm-compatible node_modules), deduplicating wherever a
 *           compatible version is visible and never shadowing an already-resolved dependency.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { addToStore, verifyIntegrity } from "./store.ts";
import { STRATO_HOME, type Manifest, type Registry } from "./registry.ts";

export const gitCacheDir = (resolvedUrl: string) =>
  join(STRATO_HOME, "cache", "git", createHash("sha256").update(resolvedUrl).digest("hex").slice(0, 24));

export type Kind = "registry" | "tarball" | "git" | "link" | "workspace";

export interface Resolved {
  id: string; name: string; version: string; kind: Kind;
  /** Tarball URL, local path (relative to project root) or git URL#commit */
  resolved: string;
  integrity?: string;
  dependencies: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: Record<string, string>;
  hasInstallScript?: boolean;
  os?: string[]; cpu?: string[];
  deprecated?: string;
  /** For git/link/workspace: directory already holding the files. */
  dir?: string;
}

export interface LockEntry extends Omit<Resolved, "id" | "dir"> { optional?: boolean; dev?: boolean }
export interface Lockfile {
  lockfileVersion: 1;
  root: { dependencies: Record<string, string> };
  packages: Record<string, LockEntry>;
}

export interface ParsedSpec { type: "range" | "tag" | "alias" | "file" | "git" | "tarball" | "workspace"; name: string; spec: string }

export function parseSpec(name: string, spec: string): ParsedSpec {
  spec = spec.trim() || "*";
  if (spec.startsWith("npm:")) {
    const body = spec.slice(4);
    const at = body.lastIndexOf("@");
    return at > 0 ? { type: "alias", name: body.slice(0, at), spec: body.slice(at + 1) } : { type: "alias", name: body, spec: "*" };
  }
  if (spec.startsWith("workspace:")) return { type: "workspace", name, spec: spec.slice(10) };
  if (/^(file:|link:|\.\.?\/|\/|~\/)/.test(spec)) return { type: "file", name, spec: spec.replace(/^(file:|link:)/, "") };
  if (/^(git\+|git:\/\/|github:|gitlab:|bitbucket:)/.test(spec) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec)) return { type: "git", name, spec };
  if (/^https?:\/\//.test(spec)) return { type: "tarball", name, spec };
  if (Bun.semver.satisfies("0.0.0", spec) || /^[\^~<>=\d*xX|\s.-]/.test(spec) || /^v?\d/.test(spec)) return { type: "range", name, spec };
  return { type: "tag", name, spec };
}

/** Split "pkg@range" / "@scope/pkg@range" / "alias@npm:pkg@1" CLI args. */
export function splitNameSpec(arg: string): { name: string; spec: string } {
  const at = arg.indexOf("@", 1);
  if (at < 0) return { name: arg, spec: "" };
  return { name: arg.slice(0, at), spec: arg.slice(at + 1) };
}

export function maxSatisfying(versions: string[], range: string): string | undefined {
  let best: string | undefined;
  for (const v of versions) if (Bun.semver.satisfies(v, range) && (!best || Bun.semver.order(v, best) > 0)) best = v;
  return best;
}

const platformOk = (m: { os?: string[]; cpu?: string[] }) => {
  const check = (list: string[] | undefined, cur: string) => {
    if (!list || !list.length) return true;
    const neg = list.filter((x) => x.startsWith("!")).map((x) => x.slice(1));
    const pos = list.filter((x) => !x.startsWith("!"));
    if (neg.includes(cur)) return false;
    return pos.length === 0 || pos.includes(cur);
  };
  return check(m.os, process.platform) && check(m.cpu, process.arch);
};

const normBin = (name: string, bin: Manifest["bin"]): Record<string, string> | undefined => {
  if (!bin) return undefined;
  if (typeof bin === "string") return { [name.startsWith("@") ? name.split("/")[1]! : name]: bin };
  return bin;
};

export interface Workspace { name: string; version: string; dir: string; pkg: any }

export interface ResolveOptions {
  root: string;
  registry: Registry;
  lock?: Lockfile;
  /** Package names that must be re-resolved even if locked (update). */
  refresh?: Set<string> | "all";
  overrides?: Record<string, string>;
  workspaces?: Map<string, Workspace>;
  onProgress?: (resolved: number) => void;
}

export interface Graph {
  nodes: Map<string, Resolved>;
  /** edge key `${name}@${spec}` -> resolved id */
  edges: Map<string, string>;
  rootDeps: Record<string, string>;
  optionalSkipped: string[];
  warnings: string[];
}

export async function resolveGraph(rootDeps: Record<string, string>, opts: ResolveOptions): Promise<Graph> {
  const g: Graph = { nodes: new Map(), edges: new Map(), rootDeps, optionalSkipped: [], warnings: [] };
  const inflight = new Map<string, Promise<string | null>>();
  const pending: Promise<unknown>[] = [];
  const lockedByName = new Map<string, LockEntry[]>();
  for (const e of Object.values(opts.lock?.packages ?? {})) {
    const l = lockedByName.get(e.name) ?? []; l.push(e); lockedByName.set(e.name, l);
  }

  const resolveEdge = async (depName: string, origSpec: string, optional: boolean): Promise<string | null> => {
    const spec = opts.overrides?.[depName] ?? origSpec;
    const id = await resolveEdgeInner(depName, spec, optional);
    if (id) g.edges.set(`${depName}@${origSpec}`, id);
    return id;
  };
  const resolveEdgeInner = (depName: string, spec: string, optional: boolean): Promise<string | null> => {
    const key = `${depName}@${spec}`;
    let p = inflight.get(key);
    if (!p) {
      p = (async () => {
        try {
          const r = await resolveOne(depName, spec);
          if (!r) return null;
          g.edges.set(key, r.id);
          if (!g.nodes.has(r.id)) {
            g.nodes.set(r.id, r);
            opts.onProgress?.(g.nodes.size);
            for (const [n, s] of Object.entries(r.dependencies)) pending.push(resolveEdge(n, s, false));
            for (const [n, s] of Object.entries(r.optionalDependencies ?? {})) pending.push(resolveEdge(n, s, true));
            for (const [n, s] of Object.entries(r.peerDependencies ?? {})) pending.push(resolveEdge(n, s, true));
          }
          return r.id;
        } catch (e) {
          if (optional) { g.optionalSkipped.push(`${key}: ${(e as Error).message}`); return null; }
          throw e;
        }
      })();
      inflight.set(key, p);
    }
    return p;
  };

  const resolveOne = async (depName: string, rawSpec: string): Promise<Resolved | null> => {
    const ps = parseSpec(depName, rawSpec);
    const refresh = opts.refresh === "all" || opts.refresh?.has(depName);

    if (ps.type === "workspace") {
      const ws = opts.workspaces?.get(depName);
      if (!ws) throw new Error(`workspace:${ps.spec} — no workspace named "${depName}"`);
      return { id: `${ws.name}@workspace`, name: ws.name, version: ws.version, kind: "workspace", resolved: relative(opts.root, ws.dir) || ".", dependencies: { ...ws.pkg.dependencies }, optionalDependencies: ws.pkg.optionalDependencies, bin: normBin(ws.name, ws.pkg.bin), dir: ws.dir };
    }
    if (ps.type === "file") {
      const dir = isAbsolute(ps.spec) ? ps.spec : resolve(opts.root, ps.spec.replace(/^~\//, process.env.HOME + "/"));
      const pj = join(dir, "package.json");
      if (!existsSync(pj)) throw new Error(`Local dependency ${depName} → ${dir} has no package.json`);
      const pkg = JSON.parse(readFileSync(pj, "utf8"));
      return { id: `${depName}@file:${relative(opts.root, dir)}`, name: depName, version: pkg.version ?? "0.0.0", kind: "link", resolved: relative(opts.root, dir), dependencies: { ...pkg.dependencies }, optionalDependencies: pkg.optionalDependencies, bin: normBin(depName, pkg.bin), dir };
    }
    if (ps.type === "git") return resolveGit(depName, ps.spec);
    if (ps.type === "tarball") {
      const locked = !refresh && lockedByName.get(depName)?.find((e) => e.resolved === ps.spec);
      if (locked) return fromLock(locked);
      const buf = await opts.registry.tarball(ps.spec);
      const integrity = verifyIntegrity(buf);
      const dir = addToStore(buf, integrity);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return { id: `${depName}@${ps.spec}`, name: depName, version: pkg.version, kind: "tarball", resolved: ps.spec, integrity, dependencies: { ...pkg.dependencies }, optionalDependencies: pkg.optionalDependencies, peerDependencies: requiredPeers(pkg), bin: normBin(depName, pkg.bin), hasInstallScript: hasScripts(pkg) };
    }

    // registry (range | tag | alias)
    const realName = ps.type === "alias" ? ps.name : depName;
    const range = ps.spec;
    if (!refresh && ps.type !== "tag") {
      const cands = (lockedByName.get(depName) ?? []).filter((e) => e.kind === "registry" && Bun.semver.satisfies(e.version, range));
      if (cands.length) {
        cands.sort((a, b) => Bun.semver.order(b.version, a.version));
        return fromLock(cands[0]!);
      }
    }
    const pack = await opts.registry.packument(realName);
    let version: string | undefined;
    if (ps.type === "tag" || (ps.type === "alias" && pack["dist-tags"][range])) version = pack["dist-tags"][range];
    else {
      const latest = pack["dist-tags"].latest;
      // npm semantics: prefer the `latest` tag when it satisfies the range
      version = latest && Bun.semver.satisfies(latest, range) ? latest : maxSatisfying(Object.keys(pack.versions), range);
    }
    if (!version || !pack.versions[version]) throw new Error(`No version of "${realName}" matches "${rawSpec}"`);
    const m = pack.versions[version]!;
    if (!platformOk(m)) throw new Error(`${realName}@${version} unsupported on ${process.platform}/${process.arch}`);
    return {
      id: `${depName}@${version}${ps.type === "alias" ? `(npm:${realName})` : ""}`,
      name: depName, version, kind: "registry", resolved: m.dist.tarball,
      integrity: m.dist.integrity ?? (m.dist.shasum ? `sha1-${Buffer.from(m.dist.shasum, "hex").toString("base64")}` : undefined),
      dependencies: { ...m.dependencies },
      optionalDependencies: m.optionalDependencies && Object.keys(m.optionalDependencies).length ? m.optionalDependencies : undefined,
      peerDependencies: requiredPeers(m),
      bin: normBin(depName, m.bin),
      hasInstallScript: m.hasInstallScript || undefined,
      os: m.os, cpu: m.cpu, deprecated: m.deprecated,
    };
  };

  const fromLock = (e: LockEntry): Resolved => {
    const aliasMatch = e.kind === "registry" ? /\/(@[^/]+\/[^/]+|[^/@]+)\/-\//.exec(e.resolved) : null;
    const real = aliasMatch?.[1];
    const id = e.kind === "registry" ? `${e.name}@${e.version}${real && real !== e.name ? `(npm:${real})` : ""}` : `${e.name}@${e.resolved}`;
    const { optional, dev, ...rest } = e;
    return { ...rest, id, dependencies: { ...e.dependencies } };
  };

  const resolveGit = async (depName: string, spec: string): Promise<Resolved> => {
    let url = spec.replace(/^git\+/, "");
    let ref = "";
    const hash = url.indexOf("#");
    if (hash >= 0) { ref = url.slice(hash + 1); url = url.slice(0, hash); }
    if (url.startsWith("github:") || /^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url.replace(/^github:/, "")}.git`;
    else if (url.startsWith("gitlab:")) url = `https://gitlab.com/${url.slice(7)}.git`;
    else if (url.startsWith("bitbucket:")) url = `https://bitbucket.org/${url.slice(10)}.git`;
    const locked = lockedByName.get(depName)?.find((e) => e.kind === "git" && e.resolved.startsWith(url + "#"));
    if (locked && existsSync(join(gitCacheDir(locked.resolved), "package.json"))) {
      const dir = gitCacheDir(locked.resolved);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return { id: `${depName}@git:${locked.resolved}`, name: depName, version: pkg.version ?? "0.0.0", kind: "git", resolved: locked.resolved, dependencies: { ...pkg.dependencies }, bin: normBin(depName, pkg.bin), hasInstallScript: hasScripts(pkg), dir };
    }
    let dir = gitCacheDir(`${url}#${ref}`) + ".tmp" + process.pid;
    {
      if (opts.registry.offline) throw new Error(`Offline: git dependency ${spec} not cached`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, ".."), { recursive: true });
      const args = ["git", "clone", "--depth", "1", ...(ref && !/^[0-9a-f]{40}$/.test(ref) ? ["--branch", ref] : []), url, dir];
      const p = Bun.spawnSync(args, { stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(`git clone failed for ${url}: ${p.stderr.toString().trim()}`);
      if (/^[0-9a-f]{40}$/.test(ref)) {
        Bun.spawnSync(["git", "-C", dir, "fetch", "--depth", "1", "origin", ref]);
        Bun.spawnSync(["git", "-C", dir, "checkout", ref]);
      }
    }
    const commit = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"]).stdout.toString().trim();
    const final = gitCacheDir(`${url}#${commit}`);
    if (existsSync(join(final, "package.json"))) rmSync(dir, { recursive: true, force: true });
    else { rmSync(final, { recursive: true, force: true }); renameSync(dir, final); }
    dir = final;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return { id: `${depName}@git:${commit}`, name: depName, version: pkg.version ?? "0.0.0", kind: "git", resolved: `${url}#${commit}`, dependencies: { ...pkg.dependencies }, optionalDependencies: pkg.optionalDependencies, bin: normBin(depName, pkg.bin), hasInstallScript: hasScripts(pkg), dir };
  };

  for (const [n, s] of Object.entries(rootDeps)) pending.push(resolveEdge(n, s, false));
  // Children are queued rather than awaited inside their parent, so dependency cycles cannot deadlock.
  while (pending.length) await Promise.all(pending.splice(0));
  return g;
}

function requiredPeers(m: { peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }) {
  if (!m.peerDependencies) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.peerDependencies)) if (!m.peerDependenciesMeta?.[k]?.optional) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}
const hasScripts = (pkg: any) => !!(pkg.scripts?.preinstall || pkg.scripts?.install || pkg.scripts?.postinstall) || undefined;

/** Phase 2: hoisted, deterministic layout. Returns map of install path -> resolved id. */
export function layout(g: Graph): Map<string, string> {
  const placed = new Map<string, string>();
  const passed = new Set<string>(); // `${level}\0${name}`: something below resolved `name` through this level
  const nm = (level: string, name: string) => (level ? `${level}/node_modules/${name}` : `node_modules/${name}`);
  const parentLevel = (level: string) => {
    const i = level.lastIndexOf("/node_modules/");
    return i < 0 ? (level ? "" : null) : level.slice(0, i);
  };

  const queue: { level: string; id: string }[] = [];
  const place = (from: string, name: string, id: string) => {
    let candidate: string | null = null;
    const walked: string[] = [];
    for (let L: string | null = from; L !== null; L = parentLevel(L)) {
      const here = placed.get(nm(L, name));
      if (here) {
        if (here === id) { for (const w of walked) passed.add(`${w}\0${name}`); return; }
        break;
      }
      if (passed.has(`${L}\0${name}`)) break;
      candidate = L;
      walked.push(L);
    }
    if (candidate === null) {
      // Conflict directly at parent's own node_modules can't happen (each name once per level); nest under parent.
      candidate = from;
    }
    for (const w of walked) { if (w === candidate) break; passed.add(`${w}\0${name}`); }
    const p = nm(candidate, name);
    placed.set(p, id);
    queue.push({ level: p, id });
  };

  const depsOf = (r: Resolved) => {
    const out: [string, string][] = [];
    for (const [n, s] of Object.entries(r.dependencies)) out.push([n, s]);
    for (const [n, s] of Object.entries(r.optionalDependencies ?? {})) out.push([n, s]);
    for (const [n, s] of Object.entries(r.peerDependencies ?? {})) out.push([n, s]);
    return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  };

  for (const [n, s] of Object.entries(g.rootDeps).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const id = g.edges.get(`${n}@${s}`);
    if (id) { placed.set(nm("", n), id); queue.push({ level: nm("", n), id }); }
  }
  while (queue.length) {
    const { level, id } = queue.shift()!;
    const node = g.nodes.get(id)!;
    const peers = node.peerDependencies ?? {};
    for (const [n, s] of depsOf(node)) {
      const cid = g.edges.get(`${n}@${s}`);
      if (!cid) continue;
      if (n in peers && !(n in node.dependencies)) {
        // peers are provided by the parent: place at the level containing this package
        const parent = parentLevel(level) ?? "";
        place(parent, n, cid);
      } else place(level, n, cid);
    }
  }
  return new Map([...placed.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}
