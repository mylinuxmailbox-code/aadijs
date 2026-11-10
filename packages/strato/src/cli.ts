/**
 * Strato CLI — usable standalone (`strato …`) or embedded by `aadi`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { AadiError, c, fmtBytes, fmtMs, log, parseArgs, suggest } from "../../utils/src/index.ts";
import { findWorkspaces, install, LOCKFILE, printStats, readLock, readPkg, runScript, writePkg } from "./installer.ts";
import { Registry, readNpmrc, STRATO_HOME, META_DIR } from "./registry.ts";
import { maxSatisfying, splitNameSpec, parseSpec } from "./resolver.ts";
import { createTgz, pruneStore, STORE_DIR, verifyIntegrity } from "./store.ts";

export const STRATO_VERSION = "0.1.0";

const VALUE_FLAGS = ["registry", "depth", "format", "older-than", "omit", "tag", "access", "link-mode", "filter", "otp"];

const HELP = `${c.bold(c.cyan("strato"))} ${c.dim(STRATO_VERSION)} — the package manager built for absolute speed

${c.bold("Usage")}  strato <command> [options]

${c.bold("Commands")}
  install, i            Install all dependencies          (--frozen-lockfile, --offline, --production, --ignore-scripts)
  add <pkg…>            Add dependencies                  (-D dev, -O optional, -E exact, --peer)
  remove, rm <pkg…>     Remove dependencies
  update [pkg…]         Re-resolve within existing ranges
  upgrade [pkg…]        Bump ranges to the latest versions
  run <script> [args]   Run a package.json script (falls back to running a file with Bun)
  dev | build | test    Shortcuts for the matching script
  audit                 Check installed packages against the registry advisory DB
  outdated              Show packages with newer versions
  list, ls              Print the dependency tree       (--depth N)
  why <pkg>             Explain why a package is installed
  graph                 Dependency graph                 (--format mermaid|dot|json)
  info <pkg>            Show registry metadata
  cache <clean|prune|dir|stats>
  doctor                Diagnose environment
  init                  Create package.json
  pack | publish        Create tarball / publish to registry (--dry-run, --tag, --access)
  workspace <list|run>  Monorepo tools

${c.bold("Global")}  --json  --quiet  --verbose  --cwd=<dir>`;

export async function stratoMain(argv: string[]): Promise<number> {
  const a = parseArgs(argv, VALUE_FLAGS);
  const f = a.flags;
  if (f.json) log.json = true;
  if (f.quiet || f.q) log.level = "quiet";
  if (f.verbose) log.level = "verbose";
  const cwd = typeof f.cwd === "string" ? f.cwd : process.cwd();
  const [cmd = "", ...args] = a._;
  if (f.version || f.v) { console.log(STRATO_VERSION); return 0; }
  if (!cmd && (f.help || f.h)) { console.log(HELP); return 0; }

  const installOpts = () => ({
    cwd,
    frozen: !!(f["frozen-lockfile"] || f.ci || f.immutable),
    offline: !!f.offline,
    preferOffline: !!f["prefer-offline"],
    production: !!(f.production || f.prod || f.omit === "dev"),
    ignoreScripts: !!f["ignore-scripts"],
    allowScripts: !!f["allow-scripts"],
    linkMode: f["link-mode"] as any,
    dryRun: !!f["dry-run"],
  });
  const doInstall = async (extra: Partial<ReturnType<typeof installOpts>> & { refresh?: Set<string> | "all" } = {}) => {
    const stats = await install({ ...installOpts(), ...extra });
    if (log.json) log.result({ ok: true, ...stats }); else printStats(stats);
    return 0;
  };

  switch (cmd) {
    case "":
    case "install": case "i": case "ci":
      if (args.length) return stratoMain(["add", ...argv.filter((x) => x !== "install" && x !== "i")]);
      return doInstall(cmd === "ci" ? { frozen: true } : {});

    case "add": case "a": {
      if (!args.length) throw new AadiError("No packages specified", "e.g. strato add react  |  strato add -D typescript");
      const pkg = readPkg(cwd);
      const field = f.D || f.dev || f["save-dev"] ? "devDependencies" : f.O || f.optional ? "optionalDependencies" : f.peer ? "peerDependencies" : "dependencies";
      const reg = new Registry(readNpmrc(cwd), !!f.offline);
      await Promise.all(args.map(async (arg) => {
        const { name, spec } = splitNameSpec(arg);
        const ps = parseSpec(name, spec || "latest");
        let saved = spec;
        if (ps.type === "range" || ps.type === "tag") {
          const pack = await reg.packument(name);
          const v = ps.type === "tag" ? pack["dist-tags"][ps.spec] : maxSatisfying(Object.keys(pack.versions), ps.spec);
          if (!v) throw new AadiError(`No version of ${name} matches "${spec}"`);
          saved = ps.type === "range" && spec ? spec : f.E || f.exact ? v : `^${v}`;
        }
        for (const k of ["dependencies", "devDependencies", "optionalDependencies"]) if (k !== field) delete pkg[k]?.[name];
        (pkg[field] ??= {})[name] = saved;
        log.info(`${c.green("+")} ${name}${c.dim("@" + saved)} ${c.dim(field === "dependencies" ? "" : `(${field})`)}`);
      }));
      pkg[field] = Object.fromEntries(Object.entries(pkg[field]).sort(([x], [y]) => (x < y ? -1 : 1)));
      writePkg(cwd, pkg);
      return doInstall();
    }

    case "remove": case "rm": case "uninstall": case "un": {
      if (!args.length) throw new AadiError("No packages specified");
      const pkg = readPkg(cwd);
      for (const n of args) {
        let found = false;
        for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) if (pkg[k]?.[n]) { delete pkg[k][n]; found = true; }
        if (!found) log.warn(`${n} is not a dependency`); else log.info(`${c.red("−")} ${n}`);
      }
      writePkg(cwd, pkg);
      return doInstall();
    }

    case "update": case "up":
      return doInstall({ refresh: args.length ? new Set(args) : "all" });

    case "upgrade": {
      const pkg = readPkg(cwd);
      const reg = new Registry(readNpmrc(cwd));
      const jobs: Promise<void>[] = [];
      for (const k of ["dependencies", "devDependencies", "optionalDependencies"]) for (const [n, s] of Object.entries<string>(pkg[k] ?? {})) {
        if (args.length && !args.includes(n)) continue;
        if (parseSpec(n, s).type !== "range") continue;
        jobs.push(reg.packument(n).then((p) => {
          const latest = p["dist-tags"].latest!;
          const prefix = /^[\^~]/.test(s) ? s[0] : "";
          const next = prefix + latest;
          if (next !== s) { pkg[k][n] = next; log.info(`${c.cyan("↑")} ${n} ${c.dim(s)} → ${c.green(next)}`); }
        }));
      }
      await Promise.all(jobs);
      writePkg(cwd, pkg);
      return doInstall({ refresh: args.length ? new Set(args) : "all" });
    }

    case "run": case "run-script": {
      const [script, ...rest] = args;
      const pkg = readPkg(cwd);
      if (!script) { log.info(Object.entries(pkg.scripts ?? {}).map(([k, v]) => `  ${c.cyan(k)}  ${c.dim(String(v))}`).join("\n") || "No scripts."); return 0; }
      return runPkgScript(cwd, pkg, script, [...rest, ...a.rest]);
    }
    case "dev": case "build": case "test": case "start": {
      const pkg = readPkg(cwd);
      return runPkgScript(cwd, pkg, cmd, [...args, ...a.rest]);
    }

    case "audit": return audit(cwd, !!f.fix);
    case "outdated": return outdated(cwd);
    case "list": case "ls": return list(cwd, Number(f.depth ?? (f.all ? 99 : 0)));
    case "why": return why(cwd, args[0]);
    case "graph": return graph(cwd, (f.format as string) ?? "mermaid");
    case "info": case "view": case "show": return info(cwd, args[0]);
    case "cache": return cache(args[0], Number(f["older-than"] ?? 30));
    case "doctor": return doctor(cwd);
    case "init": return init(cwd, !!(f.y || f.yes));
    case "pack": return pack(cwd, false, f);
    case "publish": return pack(cwd, true, f);
    case "workspace": case "workspaces": case "ws": return workspace(cwd, args, a.rest);
    case "help": console.log(HELP); return 0;
    default: {
      const pkg = existsSync(join(cwd, "package.json")) ? readPkg(cwd) : {};
      if (pkg.scripts?.[cmd]) return runPkgScript(cwd, pkg, cmd, [...args, ...a.rest]);
      const s = suggest(cmd, ["install", "add", "remove", "update", "upgrade", "run", "audit", "outdated", "list", "info", "cache", "doctor", "init", "publish", "workspace", "why", "graph"]);
      throw new AadiError(`Unknown command "${cmd}"`, s ? `Did you mean \`strato ${s}\`?` : "Run `strato help`.");
    }
  }
}

export async function runPkgScript(cwd: string, pkg: any, script: string, args: string[]): Promise<number> {
  const s = pkg.scripts?.[script];
  if (!s) {
    if (existsSync(join(cwd, script))) return await Bun.spawn([process.execPath, script, ...args], { cwd, stdio: ["inherit", "inherit", "inherit"] }).exited;
    const sug = suggest(script, Object.keys(pkg.scripts ?? {}));
    throw new AadiError(`No script named "${script}"`, sug ? `Did you mean "${sug}"?` : `Available: ${Object.keys(pkg.scripts ?? {}).join(", ") || "none"}`);
  }
  try {
    if (pkg.scripts[`pre${script}`]) await runScript(cwd, `pre${script}`, pkg.scripts[`pre${script}`], cwd);
    await runScript(cwd, script, s, cwd, args);
    if (pkg.scripts[`post${script}`]) await runScript(cwd, `post${script}`, pkg.scripts[`post${script}`], cwd);
  } catch (e: any) { if (e.exitCode) { log.error(e.message); return e.exitCode; } throw e; }
  return 0;
}

function requireLock(cwd: string) {
  const l = readLock(cwd);
  if (!l) throw new AadiError(`No ${LOCKFILE} found`, "Run `strato install` first.");
  return l;
}

async function audit(cwd: string, fix: boolean) {
  const lock = requireLock(cwd);
  const body: Record<string, string[]> = {};
  for (const e of Object.values(lock.packages)) if (e.kind === "registry") (body[e.name] ??= []).includes(e.version) || body[e.name]!.push(e.version);
  const reg = new Registry(readNpmrc(cwd));
  const url = reg.cfg.registry + "-/npm/v1/security/advisories/bulk";
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...reg.authHeader(url) }, body: JSON.stringify(body) });
  if (!res.ok) throw new AadiError(`Audit endpoint returned HTTP ${res.status}`, "Your registry may not support the npm bulk advisory API.");
  const adv = (await res.json()) as Record<string, { id: number; title: string; severity: string; vulnerable_versions: string; url: string }[]>;
  const findings: any[] = [];
  for (const [name, list] of Object.entries(adv)) for (const a of list)
    for (const v of body[name] ?? []) if (Bun.semver.satisfies(v, a.vulnerable_versions)) findings.push({ name, version: v, ...a });
  if (fix && findings.length) {
    const pkg = readPkg(cwd);
    pkg.overrides ??= {};
    const fixed: string[] = [];
    for (const x of findings) {
      const p = await reg.packument(x.name);
      const safe = Object.keys(p.versions)
        .filter((v) => !Bun.semver.satisfies(v, x.vulnerable_versions) && Bun.semver.order(v, x.version) > 0)
        .sort((a, b) => Bun.semver.order(b, a))[0];
      if (safe) {
        pkg.overrides[x.name] = `^${safe}`;
        if (pkg.dependencies?.[x.name]) pkg.dependencies[x.name] = `^${safe}`;
        if (pkg.devDependencies?.[x.name]) pkg.devDependencies[x.name] = `^${safe}`;
        fixed.push(`${x.name}@^${safe}`);
      }
    }
    if (fixed.length) {
      writePkg(cwd, pkg);
      log.success(`Applied security overrides: ${[...new Set(fixed)].join(", ")}`);
      await install({ cwd, refresh: new Set(findings.map((x) => x.name)) });
      return 0;
    }
  }
  if (log.json) { log.result({ ok: findings.length === 0, findings }); return findings.length ? 1 : 0; }
  const sevColor: Record<string, (s: string) => string> = { critical: c.red, high: c.red, moderate: c.yellow, low: c.gray };
  for (const x of findings) log.info(`${(sevColor[x.severity] ?? c.gray)(x.severity.toUpperCase().padEnd(9))} ${c.bold(x.name)}@${x.version}  ${x.title}\n          ${c.dim(x.url)}`);
  if (!findings.length) log.success(`No known vulnerabilities in ${Object.keys(body).length} packages`);
  else log.info(`\n${findings.length} vulnerabilities found. Run ${c.cyan("strato audit --fix")} or ${c.cyan("strato update <pkg>")}.`);
  return findings.length ? 1 : 0;
}

async function outdated(cwd: string) {
  const pkg = readPkg(cwd);
  const lock = readLock(cwd);
  const reg = new Registry(readNpmrc(cwd));
  const rows: { name: string; current: string; wanted: string; latest: string; type: string }[] = [];
  await Promise.all(["dependencies", "devDependencies", "optionalDependencies"].flatMap((k) =>
    Object.entries<string>(pkg[k] ?? {}).filter(([n, s]) => parseSpec(n, s).type === "range").map(async ([n, s]) => {
      const p = await reg.packument(n);
      const current = lock?.packages[`node_modules/${n}`]?.version ?? "—";
      const wanted = maxSatisfying(Object.keys(p.versions), s) ?? "—";
      const latest = p["dist-tags"].latest ?? "—";
      if (current !== latest || wanted !== current) rows.push({ name: n, current, wanted, latest, type: k });
    })));
  rows.sort((x, y) => (x.name < y.name ? -1 : 1));
  if (log.json) { log.result(rows); return 0; }
  if (!rows.length) { log.success("All dependencies are up to date"); return 0; }
  log.info(c.bold(`${"Package".padEnd(32)}${"Current".padEnd(12)}${"Wanted".padEnd(12)}${"Latest".padEnd(12)}Type`));
  for (const r of rows) log.info(`${r.name.padEnd(32)}${r.current.padEnd(12)}${c.green(r.wanted.padEnd(12))}${c.cyan(r.latest.padEnd(12))}${c.dim(r.type)}`);
  return 0;
}

function list(cwd: string, depth: number) {
  const lock = requireLock(cwd);
  const top = Object.entries(lock.packages).filter(([p]) => p.split("/node_modules/").length === 1);
  if (log.json) { log.result(lock.packages); return 0; }
  const pkg = readPkg(cwd);
  log.info(`${c.bold(pkg.name ?? basename(cwd))}${c.dim("@" + (pkg.version ?? "0.0.0"))} ${c.dim(cwd)}`);
  const find = (from: string, name: string) => {
    for (let L: string | null = from; L !== null; ) {
      const p = L ? `${L}/node_modules/${name}` : `node_modules/${name}`;
      if (lock.packages[p]) return p;
      const i = L.lastIndexOf("/node_modules/"); L = i < 0 ? (L ? "" : null) : L.slice(0, i);
    }
  };
  const printNode = (p: string, prefix: string, last: boolean, d: number, seen: Set<string>) => {
    const e = lock.packages[p]!;
    log.info(`${prefix}${last ? "└─" : "├─"} ${e.name}${c.dim("@" + e.version)}${seen.has(p) ? c.dim(" (deduped)") : ""}`);
    if (d >= depth || seen.has(p)) return;
    seen.add(p);
    const kids = Object.keys(e.dependencies ?? {}).map((n) => find(p, n)).filter(Boolean) as string[];
    kids.forEach((k, i) => printNode(k, prefix + (last ? "   " : "│  "), i === kids.length - 1, d + 1, seen));
  };
  const roots = Object.keys(lock.root.dependencies).filter((k) => !k.includes(">")).map((n) => `node_modules/${n}`).filter((p) => lock.packages[p]);
  roots.forEach((p, i) => printNode(p, "", i === roots.length - 1, 0, new Set()));
  log.info(c.dim(`\n${Object.keys(lock.packages).length} packages total (${top.length} top-level)`));
  return 0;
}

function why(cwd: string, name?: string) {
  if (!name) throw new AadiError("Usage: strato why <package>");
  const lock = requireLock(cwd);
  const hits = Object.entries(lock.packages).filter(([, e]) => e.name === name);
  if (!hits.length) throw new AadiError(`${name} is not installed`);
  const dependents = (target: string, version: string) =>
    Object.entries(lock.packages).filter(([, e]) => { const s = e.dependencies?.[target] ?? e.optionalDependencies?.[target] ?? e.peerDependencies?.[target]; return s !== undefined && (parseSpec(target, s).type !== "range" || Bun.semver.satisfies(version, s)); });
  const out: any[] = [];
  for (const [p, e] of hits) {
    const direct = lock.root.dependencies[name];
    const by = dependents(name, e.version).map(([, d]) => `${d.name}@${d.version}`);
    out.push({ path: p, version: e.version, direct: direct ?? null, requiredBy: [...new Set(by)] });
    log.info(`${c.bold(name)}@${e.version} ${c.dim(p)}`);
    if (direct) log.info(`  ${c.green("●")} direct dependency (${direct})`);
    for (const b of new Set(by)) log.info(`  ${c.cyan("←")} ${b}`);
  }
  log.result(out);
  return 0;
}

function graph(cwd: string, format: string) {
  const lock = requireLock(cwd);
  const nodes = new Map<string, string>();
  const edges = new Set<string>();
  const id = (n: string, v: string) => { const k = `${n}@${v}`; if (!nodes.has(k)) nodes.set(k, `n${nodes.size}`); return nodes.get(k)!; };
  const byName = new Map<string, string[]>();
  for (const e of Object.values(lock.packages)) (byName.get(e.name) ?? byName.set(e.name, []).get(e.name)!).push(e.version);
  for (const e of Object.values(lock.packages)) for (const [d, s] of Object.entries(e.dependencies ?? {})) {
    const v = (byName.get(d) ?? []).find((x) => parseSpec(d, s).type !== "range" || Bun.semver.satisfies(x, s));
    if (v) edges.add(`${id(e.name, e.version)}|${id(d, v)}`);
  }
  if (format === "json") { console.log(JSON.stringify({ nodes: [...nodes.keys()], edges: [...edges].map((x) => x.split("|")) }, null, 2)); return 0; }
  const label = new Map([...nodes].map(([k, v]) => [v, k]));
  if (format === "dot") {
    console.log("digraph deps {\n  rankdir=LR;\n" + [...nodes].map(([k, v]) => `  ${v} [label="${k}"];`).join("\n") + "\n" + [...edges].map((x) => `  ${x.replace("|", " -> ")};`).join("\n") + "\n}");
  } else {
    console.log("graph LR\n" + [...edges].map((x) => { const [a, b] = x.split("|"); return `  ${a}["${label.get(a!)}"] --> ${b}["${label.get(b!)}"]`; }).join("\n"));
  }
  return 0;
}

async function info(cwd: string, name?: string) {
  if (!name) throw new AadiError("Usage: strato info <package>");
  const { name: n, spec } = splitNameSpec(name);
  const reg = new Registry(readNpmrc(cwd));
  const p = await reg.fullPackument(n);
  const v = spec ? maxSatisfying(Object.keys(p.versions), spec) ?? p["dist-tags"][spec] : p["dist-tags"].latest;
  const m = p.versions[v];
  if (!m) throw new AadiError(`No version ${spec} of ${n}`);
  if (log.json) { log.result(m); return 0; }
  log.info(`${c.bold(c.cyan(m.name))}${c.dim("@" + m.version)}  ${m.license ? c.green(m.license) : ""}`);
  if (m.description) log.info(m.description);
  if (m.homepage) log.info(c.blue(m.homepage));
  log.info(`\n${c.bold("dist-tags")}: ${Object.entries(p["dist-tags"]).map(([k, x]) => `${k}: ${x}`).join("  ")}`);
  const deps = Object.entries(m.dependencies ?? {});
  log.info(`${c.bold("dependencies")} (${deps.length}): ${deps.map(([k, x]) => `${k}@${x}`).join(", ") || "none"}`);
  log.info(`${c.bold("tarball")}: ${m.dist.tarball}\n${c.bold("unpacked")}: ${m.dist.unpackedSize ? fmtBytes(m.dist.unpackedSize) : "?"}  ${c.bold("published")}: ${p.time?.[m.version] ?? "?"}`);
  log.info(`${c.bold("versions")}: ${Object.keys(p.versions).length}`);
  return 0;
}

function dirSize(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
  for (const f of new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true })) { files++; try { bytes += statSync(join(dir, f)).size; } catch {} }
  return { files, bytes };
}

function cache(sub = "stats", days: number) {
  switch (sub) {
    case "dir": console.log(STRATO_HOME); return 0;
    case "clean": case "clear":
      rmSync(join(STRATO_HOME, "store"), { recursive: true, force: true });
      rmSync(join(STRATO_HOME, "cache"), { recursive: true, force: true });
      log.success(`Cache cleared (${STRATO_HOME})`); return 0;
    case "prune": { const { removed } = pruneStore(days); log.success(`Removed ${removed} store entries unused for ${days}+ days`); return 0; }
    case "stats": case "ls": {
      const s = dirSize(STORE_DIR), m = dirSize(META_DIR);
      const entries = existsSync(STORE_DIR) ? new Bun.Glob("*").scanSync({ cwd: STORE_DIR, onlyFiles: false }) : [];
      const n = [...entries].length;
      log.result({ dir: STRATO_HOME, storeEntries: n, storeBytes: s.bytes, metaBytes: m.bytes });
      log.info(`${c.bold("Strato cache")} ${c.dim(STRATO_HOME)}\n  store:    ${n} packages, ${fmtBytes(s.bytes)}\n  metadata: ${m.files} packuments, ${fmtBytes(m.bytes)}`);
      return 0;
    }
    default: throw new AadiError(`Unknown cache subcommand "${sub}"`, "Use clean | prune | dir | stats");
  }
}

async function doctor(cwd: string) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  checks.push({ name: "Bun runtime", ok: Bun.semver.satisfies(Bun.version, ">=1.2.0"), detail: Bun.version });
  try { mkdirSync(STRATO_HOME, { recursive: true }); await Bun.write(join(STRATO_HOME, ".w"), "1"); rmSync(join(STRATO_HOME, ".w")); checks.push({ name: "Cache writable", ok: true, detail: STRATO_HOME }); }
  catch (e) { checks.push({ name: "Cache writable", ok: false, detail: (e as Error).message }); }
  const cfg = readNpmrc(cwd);
  const t = performance.now();
  try { const r = await fetch(cfg.registry + "-/ping", { signal: AbortSignal.timeout(5000) }); checks.push({ name: "Registry reachable", ok: r.ok, detail: `${cfg.registry} (${fmtMs(performance.now() - t)})` }); }
  catch (e) { checks.push({ name: "Registry reachable", ok: false, detail: `${cfg.registry}: ${(e as Error).message}` }); }
  if (existsSync(join(cwd, "package.json"))) {
    const lock = readLock(cwd);
    checks.push({ name: "Lockfile", ok: !!lock, detail: lock ? `${Object.keys(lock.packages).length} packages` : "missing — run strato install" });
    checks.push({ name: "node_modules", ok: existsSync(join(cwd, "node_modules", ".strato", "state.json")), detail: existsSync(join(cwd, "node_modules")) ? "present" : "missing" });
  }
  const git = Bun.spawnSync(["git", "--version"]);
  checks.push({ name: "git (for git deps)", ok: git.exitCode === 0, detail: git.stdout.toString().trim() || "not found" });
  if (log.json) log.result(checks);
  else for (const ch of checks) log.info(`${ch.ok ? c.green("✓") : c.red("✗")} ${ch.name.padEnd(22)} ${c.dim(ch.detail)}`);
  return checks.every((x) => x.ok) ? 0 : 1;
}

function init(cwd: string, _yes: boolean) {
  const p = join(cwd, "package.json");
  if (existsSync(p)) { log.warn("package.json already exists"); return 0; }
  writePkg(cwd, { name: basename(cwd).toLowerCase().replace(/[^a-z0-9-_.]/g, "-"), version: "0.1.0", type: "module", private: true, scripts: {}, dependencies: {} });
  log.success(`Created ${relative(process.cwd(), p) || "package.json"}`);
  return 0;
}

function packFiles(cwd: string, pkg: any): string[] {
  const always = ["package.json"];
  const ignore = (f: string) => /(^|\/)(node_modules|\.git|\.strato)(\/|$)/.test(f) || /(^|\/)\.env/.test(f) || f.endsWith(".tgz") || f === LOCKFILE;
  let files: string[];
  if (Array.isArray(pkg.files)) {
    const set = new Set<string>();
    for (const pat of pkg.files) {
      const isDir = existsSync(join(cwd, pat)) && statSync(join(cwd, pat)).isDirectory();
      for (const f of new Bun.Glob(isDir ? `${pat.replace(/\/$/, "")}/**/*` : pat).scanSync({ cwd, dot: false })) set.add(f);
    }
    for (const f of new Bun.Glob("{README,LICENSE,LICENCE}*").scanSync({ cwd })) set.add(f);
    files = [...set];
  } else files = [...new Bun.Glob("**/*").scanSync({ cwd, dot: false })];
  return [...new Set([...always, ...files.filter((f) => !ignore(f))])].sort();
}

async function pack(cwd: string, publish: boolean, f: Record<string, string | boolean>) {
  const pkg = readPkg(cwd);
  if (!pkg.name || !pkg.version) throw new AadiError("package.json needs name and version to pack");
  if (publish && pkg.private) throw new AadiError("Refusing to publish a private package", 'Remove "private": true to publish.');
  const files = packFiles(cwd, pkg);
  const tgz = createTgz(files.map((p) => ({ path: p, data: readFileSync(join(cwd, p)), mode: statSync(join(cwd, p)).mode })));
  const integrity = verifyIntegrity(tgz);
  const shasum = new Bun.CryptoHasher("sha1").update(tgz).digest("hex");
  const fname = `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`;
  log.info(`${c.bold("📦 " + pkg.name)}@${pkg.version}  ${files.length} files, ${fmtBytes(tgz.length)}`);
  log.debug(files.join("\n"));
  if (!publish) { if (!f["dry-run"]) await Bun.write(join(cwd, fname), tgz); log.success(`${fname}  ${c.dim(integrity.slice(0, 30) + "…")}`); return 0; }
  const reg = new Registry(readNpmrc(cwd));
  const base = reg.registryFor(pkg.name);
  const tag = (f.tag as string) ?? "latest";
  const tarballUrl = `${base}${pkg.name}/-/${fname.replace(/^.*?-(?=\d)/, (pkg.name.split("/").pop() ?? pkg.name) + "-")}`;
  const body = {
    _id: pkg.name, name: pkg.name, description: pkg.description, "dist-tags": { [tag]: pkg.version },
    versions: { [pkg.version]: { ...pkg, _id: `${pkg.name}@${pkg.version}`, dist: { integrity, shasum, tarball: tarballUrl } } },
    access: f.access ?? null,
    _attachments: { [fname]: { content_type: "application/octet-stream", data: Buffer.from(tgz).toString("base64"), length: tgz.length } },
  };
  if (f["dry-run"]) { log.success(`Dry run: would publish to ${base} with tag "${tag}"`); return 0; }
  const url = base + pkg.name.replace("/", "%2f");
  const headers: Record<string, string> = { "content-type": "application/json", ...reg.authHeader(url) };
  if (!headers.authorization) throw new AadiError("No auth token for registry", `Add //${new URL(base).host}/:_authToken=\${NPM_TOKEN} to .npmrc`);
  if (f.otp) headers["npm-otp"] = String(f.otp);
  const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new AadiError(`Publish failed: HTTP ${res.status} ${await res.text()}`);
  log.success(`Published ${pkg.name}@${pkg.version} (${tag})`);
  return 0;
}

async function workspace(cwd: string, args: string[], rest: string[]) {
  const pkg = readPkg(cwd);
  const ws = findWorkspaces(cwd, pkg);
  const [sub = "list", script, ...more] = args;
  if (sub === "list" || sub === "ls") {
    if (log.json) { log.result([...ws.values()].map((w) => ({ name: w.name, version: w.version, dir: relative(cwd, w.dir) }))); return 0; }
    for (const w of ws.values()) log.info(`${c.cyan(w.name)}${c.dim("@" + w.version)}  ${relative(cwd, w.dir)}`);
    if (!ws.size) log.info('No workspaces. Add "workspaces": ["packages/*"] to package.json.');
    return 0;
  }
  if (sub === "run") {
    if (!script) throw new AadiError("Usage: strato workspace run <script>");
    // Topological order: workspaces that others depend on run first.
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (n: string) => { if (seen.has(n)) return; seen.add(n); for (const d of Object.keys({ ...ws.get(n)!.pkg.dependencies, ...ws.get(n)!.pkg.devDependencies })) if (ws.has(d)) visit(d); order.push(n); };
    for (const n of ws.keys()) visit(n);
    let failed = 0;
    for (const n of order) {
      const w = ws.get(n)!;
      if (!w.pkg.scripts?.[script]) continue;
      log.info(c.bold(`\n▸ ${n}`) + c.dim(` › ${script}`));
      try { await runScript(w.dir, script, w.pkg.scripts[script], cwd, [...more, ...rest]); } catch (e) { log.error((e as Error).message); failed++; }
    }
    return failed ? 1 : 0;
  }
  throw new AadiError(`Unknown workspace subcommand "${sub}"`, "Use list | run <script>");
}
