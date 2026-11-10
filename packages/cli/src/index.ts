/**
 * `aadi` — the unified AadiJS CLI.
 * Startup budget: only utils is imported eagerly; every subsystem is loaded lazily per command.
 */
import { existsSync, readFileSync, rmSync, statSync, cpSync, writeFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { AadiError, c, fmtMs, log, parseArgs, suggest } from "../../utils/src/index.ts";

export const AADI_VERSION = "0.1.0";
const VALUE_FLAGS = ["port", "template", "provider", "model", "filter", "t", "parallel", "timeout", "format", "cwd", "mode", "target", "outdir", "registry", "depth"];
const ROOT = resolve(import.meta.dir, "../../..");

const COMMANDS: Record<string, string> = {
  create: "Create a new project            aadi create my-app [--template web|server|lib]",
  init: "Initialize AadiJS in a directory   (alias of create .)",
  dev: "Start the dev server (HMR)          --port, --host",
  build: "Production build                    --watch, --analyze, --force, --compile, --format",
  start: "Run the production build / entry",
  test: "Run tests                           --watch, --coverage, --parallel[=N], -t <filter>",
  lint: "Lint sources (biome/eslint if present, else built-in checks)",
  format: "Format sources (biome/prettier)",
  install: "Install dependencies (Strato)",
  add: "Add packages (Strato)               -D, -E",
  remove: "Remove packages (Strato)",
  update: "Update within ranges (Strato)",
  upgrade: "Upgrade to latest (Strato)",
  run: "Run a package.json script",
  doctor: "Diagnose the environment and project",
  clean: "Remove build outputs and caches",
  analyze: "Bundle analysis",
  profile: "CPU profile + startup/memory measurement of an entry",
  deploy: "Build deployable artifacts (Docker / single binary)",
  ai: "Aadi AI — explain, review, generate, fix",
  compat: "Node.js compatibility report       --write, --node",
  docs: "Generate or view API documentation  aadi docs [generate|serve]",
  info: "Show environment info",
  completion: "Shell completion script            aadi completion zsh|bash|fish",
  plugins: "List loaded plugins and their commands",
};

function help() {
  console.log(`
  ${c.bold(c.cyan("⚡ AadiJS"))} ${c.dim("v" + AADI_VERSION)}  ${c.dim("— Why wait when you can Aadi?")}

  ${c.bold("Usage")}  aadi <command> [options]

${Object.entries(COMMANDS).map(([k, v]) => `  ${c.cyan(k.padEnd(11))} ${v}`).join("\n")}

  ${c.bold("Global")}  --json  --quiet  --verbose  --cwd <dir>  --yes  --version
  ${c.dim("Strato standalone: `strato help`")}
`);
}

async function loadCtx(cwd: string) {
  const { loadConfig } = await import("../../core/src/config.ts");
  const { PluginHost } = await import("../../plugins/src/index.ts");
  const config = await loadConfig(cwd);
  const host = new PluginHost(AADI_VERSION);
  await host.load(config.plugins);
  const finalConfig = await host.emit("config", config);
  return { config: finalConfig, host };
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv, VALUE_FLAGS);
  const f = a.flags;
  if (f.json) log.json = true;
  if (f.quiet || f.q) log.level = "quiet";
  if (f.verbose) log.level = "verbose";
  const cwd = resolve(typeof f.cwd === "string" ? f.cwd : process.cwd());
  const [cmd, ...args] = a._;
  if (f.version || f.v) { console.log(log.json ? JSON.stringify({ aadi: AADI_VERSION, bun: Bun.version }) : `aadi ${AADI_VERSION} (bun ${Bun.version})`); return 0; }
  if (!cmd || cmd === "help" || f.help || f.h) { help(); return 0; }

  const strato = async (sub: string[]) => (await import("../../strato/src/cli.ts")).stratoMain([...sub, ...passthroughFlags(argv)]);

  switch (cmd) {
    case "create": case "new": case "init": return create(cmd === "init" && !args[0] ? "." : args[0], f, cwd);
    case "install": case "i": return strato(["install", ...args]);
    case "add": return strato(["add", ...args]);
    case "remove": case "rm": return strato(["remove", ...args]);
    case "update": return strato(["update", ...args]);
    case "upgrade": return strato(["upgrade", ...args]);
    case "outdated": case "audit": case "why": case "list": case "ls": case "graph": case "publish": case "pack": case "workspace": return strato([cmd, ...args]);
    case "run": return strato(["run", ...args, ...(a.rest.length ? ["--", ...a.rest] : [])]);

    case "dev": {
      const { config, host } = await loadCtx(cwd);
      if (typeof f.host === "string") config.dev.host = f.host;
      const { startDev } = await import("../../dev-server/src/index.ts");
      await startDev(config, host, { port: f.port ? Number(f.port) : undefined });
      await new Promise(() => {});
      return 0;
    }
    case "build": case "analyze": {
      const { config, host } = await loadCtx(cwd);
      if (typeof f.outdir === "string") config.outDir = f.outdir;
      if (typeof f.target === "string") config.build.target = f.target as any;
      if (f.sourcemap === false) config.build.sourcemap = "none";
      if (f.minify === false) config.build.minify = false;
      const { build, printBuild, watchBuild } = await import("../../bundler/src/index.ts");
      const formats = typeof f.format === "string" ? (f.format.split(",") as any[]) : undefined;
      if (formats?.[0]) config.build.format = formats[0];
      const opts = { config, host, force: !!f.force || cmd === "analyze", analyze: cmd === "analyze" || !!f.analyze, formats, compile: !!f.compile, mode: (f.mode === "development" ? "development" : "production") as any };
      if (f.watch || f.w) { await watchBuild(opts); return 0; }
      const r = await build(opts);
      if (log.json) log.result(r); else printBuild(r, opts.analyze);
      return r.ok ? 0 : 1;
    }
    case "start": {
      const { config } = await loadCtx(cwd);
      const out = join(config.root, config.outDir);
      if (config.mode === "web") {
        if (!existsSync(join(out, "index.html"))) throw new AadiError("No production build found", "Run `aadi build` first.");
        const { serveStatic } = await import("./static.ts");
        await serveStatic(out, Number(f.port ?? process.env.PORT ?? 3000));
        await new Promise(() => {});
      }
      const built = existsSync(join(out, "index.js")) ? join(out, "index.js") : join(config.root, config.entry ?? "index.ts");
      return await Bun.spawn([process.execPath, built, ...args], { cwd, stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, NODE_ENV: "production" } }).exited;
    }
    case "test": {
      const { config, host } = await loadCtx(cwd);
      await host.emit("testStart", { config });
      const { runTests } = await import("../../testing/src/index.ts");
      return runTests({
        cwd, watch: !!(f.watch || f.w), coverage: !!f.coverage, bail: !!f.bail, updateSnapshots: !!(f.u || f["update-snapshots"]),
        parallel: f.parallel === true ? true : f.parallel ? Number(f.parallel) : false,
        filter: (f.t ?? f.filter) as string | undefined, files: args, timeout: config.test.timeout, extra: a.rest,
      });
    }
    case "lint": return lint(cwd, args, !!f.fix);
    case "format": case "fmt": return format(cwd, args, !!f.check);
    case "clean": {
      const { config } = await loadCtx(cwd);
      for (const d of [config.outDir, ".aadi"]) rmSync(join(cwd, d), { recursive: true, force: true });
      if (f.all) rmSync(join(cwd, "node_modules"), { recursive: true, force: true });
      log.success(`Cleaned ${config.outDir}/, .aadi/${f.all ? ", node_modules/" : ""}`);
      return 0;
    }
    case "doctor": return doctor(cwd, strato);
    case "info": { const info = { aadi: AADI_VERSION, bun: Bun.version, platform: `${process.platform}/${process.arch}`, cpus: navigator.hardwareConcurrency, cwd }; if (log.json) log.result(info); else for (const [k, v] of Object.entries(info)) log.info(`${c.dim(k.padEnd(9))} ${v}`); return 0; }
    case "profile": return profile(cwd, args, a.rest);
    case "deploy": return deploy(cwd, f);
    case "ai": {
      const { config, host } = await loadCtx(cwd);
      const { aiMain } = await import("../../ai/src/index.ts");
      return aiMain(args, f, a.rest, config, host);
    }
    case "compat": return compat(!!f.write, !!f.node, args[0]);
    case "docs": return docsCmd(cwd, args[0] ?? "generate", Number(f.port ?? 4173));
    case "completion": console.log(completion(args[0] ?? "zsh")); return 0;
    case "plugins": {
      const { host } = await loadCtx(cwd);
      if (log.json) { log.result({ plugins: host.loaded, commands: [...host.commands.keys()] }); return 0; }
      log.info(host.loaded.length ? host.loaded.map((p) => `${c.cyan("●")} ${p}`).join("\n") : "No plugins configured.");
      for (const [k, v] of host.commands) log.info(`  ${c.cyan(k)}  ${c.dim(v.description)} ${c.dim(`(${v.plugin})`)}`);
      return 0;
    }
    default: {
      // Plugin commands, then package.json scripts, then suggestions.
      if (existsSync(join(cwd, "package.json")) || existsSync(join(cwd, "aadi.config.ts"))) {
        const { host } = await loadCtx(cwd);
        const pc = host.commands.get(cmd);
        if (pc) return (await pc.run(args, { cwd })) ?? 0;
        const pkg = existsSync(join(cwd, "package.json")) ? JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) : {};
        if (pkg.scripts?.[cmd]) return strato(["run", cmd, ...args]);
      }
      const s = suggest(cmd, Object.keys(COMMANDS));
      throw new AadiError(`Unknown command "${cmd}"`, s ? `Did you mean \`aadi ${s}\`?` : "Run `aadi help` to see all commands.");
    }
  }
}

function passthroughFlags(argv: string[]) {
  return argv.filter((x) => x.startsWith("-"));
}

async function create(name: string | undefined, f: Record<string, string | boolean>, cwd: string) {
  if (!name) throw new AadiError("Missing project name", "aadi create my-app");
  if (name !== "." && !/^[a-z0-9@._\/-]+$/i.test(name)) throw new AadiError(`Invalid project name "${name}"`);
  const template = (f.template as string) ?? "web";
  const src = join(ROOT, "templates", template);
  if (!existsSync(src)) throw new AadiError(`Unknown template "${template}"`, `Available: ${readdirSync(join(ROOT, "templates")).join(", ")}`);
  const dest = resolve(cwd, name);
  if (existsSync(dest) && readdirSync(dest).filter((x) => !x.startsWith(".")).length && name !== ".") throw new AadiError(`Directory ${name} is not empty`);
  const t0 = performance.now();
  cpSync(src, dest, { recursive: true, filter: (s) => !s.includes("node_modules") });
  const pj = join(dest, "package.json");
  const pkg = JSON.parse(readFileSync(pj, "utf8"));
  pkg.name = basename(dest).toLowerCase();
  writeFileSync(pj, JSON.stringify(pkg, null, 2) + "\n");
  if (existsSync(join(dest, "_gitignore"))) cpSync(join(dest, "_gitignore"), join(dest, ".gitignore")), rmSync(join(dest, "_gitignore"));
  log.success(`Created ${c.bold(pkg.name)} from ${c.cyan(template)} template in ${fmtMs(performance.now() - t0)}`);
  if (f.install !== false) {
    const { install, printStats } = await import("../../strato/src/installer.ts");
    printStats(await install({ cwd: dest }));
  }
  log.info(`\n  ${c.dim("Next:")}\n    cd ${name}\n    ${c.cyan("aadi dev")}\n`);
  return 0;
}

const SRC_EXT = /\.(m|c)?[jt]sx?$/;
function sourceFiles(cwd: string, args: string[]) {
  const pats = args.length ? args.map((x) => (existsSync(join(cwd, x)) && statSync(join(cwd, x)).isDirectory() ? `${x.replace(/\/$/, "")}/**/*` : x)) : ["**/*"];
  const out = new Set<string>();
  for (const p of pats) for (const file of new Bun.Glob(p).scanSync({ cwd })) if (SRC_EXT.test(file) && !/(^|\/)(node_modules|dist|\.aadi)\//.test(file)) out.add(file);
  return [...out].sort();
}
const localBin = (cwd: string, name: string) => [join(cwd, "node_modules/.bin", name), join(ROOT, "node_modules/.bin", name)].find(existsSync);

async function lint(cwd: string, args: string[], fix: boolean) {
  const biome = localBin(cwd, "biome"), eslint = localBin(cwd, "eslint");
  if (biome) return Bun.spawn([biome, "lint", ...(fix ? ["--write"] : []), ...(args.length ? args : ["."])], { cwd, stdio: ["inherit", "inherit", "inherit"] }).exited;
  if (eslint) return Bun.spawn([eslint, ...(fix ? ["--fix"] : []), ...(args.length ? args : ["."])], { cwd, stdio: ["inherit", "inherit", "inherit"] }).exited;
  // Built-in fast checks: syntax validity (Bun's parser), debugger statements, leftover conflict markers, focused tests.
  const t0 = performance.now();
  const files = sourceFiles(cwd, args);
  let errors = 0, warnings = 0;
  const problems: any[] = [];
  await Promise.all(files.map(async (file) => {
    const text = await Bun.file(join(cwd, file)).text();
    const loader = file.endsWith("x") ? (file.includes(".ts") ? "tsx" : "jsx") : file.includes(".ts") ? "ts" : "js";
    try { new Bun.Transpiler({ loader: loader as any }).scan(text); }
    catch (e: any) { errors++; problems.push({ file, severity: "error", rule: "syntax", message: String(e.message ?? e).split("\n")[0] }); return; }
    text.split("\n").forEach((line, i) => {
      const at = `${file}:${i + 1}`;
      if (/^\s*debugger\s*;?\s*$/.test(line)) { errors++; problems.push({ file: at, severity: "error", rule: "no-debugger", message: "debugger statement" }); }
      if (/^(<{7}|={7}|>{7})( |$)/.test(line)) { errors++; problems.push({ file: at, severity: "error", rule: "no-conflict-markers", message: "merge conflict marker" }); }
      if (/\b(test|it|describe)\.only\(/.test(line)) { warnings++; problems.push({ file: at, severity: "warn", rule: "no-focused-tests", message: ".only() left in test" }); }
      if (/\beval\(/.test(line)) { warnings++; problems.push({ file: at, severity: "warn", rule: "no-eval", message: "eval() is a security risk" }); }
    });
  }));
  if (log.json) log.result({ files: files.length, errors, warnings, problems });
  else {
    for (const p of problems) log.info(`${p.severity === "error" ? c.red("error") : c.yellow("warn ")} ${p.file}  ${p.message} ${c.dim(p.rule)}`);
    log.info(`${errors ? c.red("✗") : c.green("✓")} ${files.length} files, ${errors} errors, ${warnings} warnings in ${fmtMs(performance.now() - t0)} ${c.dim("(built-in rules; install @biomejs/biome for full linting)")}`);
  }
  return errors ? 1 : 0;
}

async function format(cwd: string, args: string[], check: boolean) {
  const biome = localBin(cwd, "biome"), prettier = localBin(cwd, "prettier");
  if (biome) return Bun.spawn([biome, "format", ...(check ? [] : ["--write"]), ...(args.length ? args : ["."])], { cwd, stdio: ["inherit", "inherit", "inherit"] }).exited;
  if (prettier) return Bun.spawn([prettier, check ? "--check" : "--write", ...(args.length ? args : ["."])], { cwd, stdio: ["inherit", "inherit", "inherit"] }).exited;
  throw new AadiError("No formatter installed", "AadiJS delegates formatting: run `aadi add -D @biomejs/biome` (fastest) or `aadi add -D prettier`.");
}

async function doctor(cwd: string, strato: (a: string[]) => Promise<number>) {
  log.info(c.bold("AadiJS doctor\n"));
  const checks: [string, boolean, string][] = [];
  checks.push(["Bun >= 1.2", Bun.semver.satisfies(Bun.version, ">=1.2.0"), Bun.version]);
  if (existsSync(join(cwd, "package.json"))) {
    try {
      const { config } = await loadCtx(cwd);
      checks.push(["Config", true, existsSync(join(cwd, "aadi.config.ts")) ? "aadi.config.ts" : "defaults"]);
      checks.push(["Entry", !!config.entry, `${config.mode}: ${config.entry ?? "not found"}`]);
    } catch (e) { checks.push(["Config", false, (e as Error).message]); }
    checks.push(["tsconfig.json", existsSync(join(cwd, "tsconfig.json")), existsSync(join(cwd, "tsconfig.json")) ? "found" : "missing (TS still works)"]);
    const env = join(cwd, ".env");
    if (existsSync(env)) {
      const gi = existsSync(join(cwd, ".gitignore")) ? readFileSync(join(cwd, ".gitignore"), "utf8") : "";
      checks.push([".env is git-ignored", /^\.env/m.test(gi), /^\.env/m.test(gi) ? "yes" : "ADD .env TO .gitignore — secrets may leak"]);
    }
  }
  for (const [n, ok, d] of checks) log.info(`${ok ? c.green("✓") : c.red("✗")} ${n.padEnd(22)} ${c.dim(d)}`);
  log.info(c.bold("\nStrato"));
  const s = await strato(["doctor"]);
  return checks.every((x) => x[1]) && s === 0 ? 0 : 1;
}

async function profile(cwd: string, args: string[], rest: string[]) {
  const entry = args[0];
  if (!entry || !existsSync(join(cwd, entry))) throw new AadiError("Usage: aadi profile <entry-file> [-- args]", "Profiles startup time, peak memory and writes a .cpuprofile");
  const runs: number[] = [];
  let rss = 0;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const p = Bun.spawn([process.execPath, entry, ...rest], { cwd, stdout: "ignore", stderr: "ignore", env: { ...process.env, AADI_PROFILE: "1" } });
    await p.exited;
    runs.push(performance.now() - t);
    rss = Math.max(rss, p.resourceUsage()?.maxRSS ?? 0);
  }
  runs.sort((x, y) => x - y);
  const out = join(cwd, ".aadi", "profile");
  const prof = Bun.spawnSync([process.execPath, "--cpu-prof", "--cpu-prof-dir", out, entry, ...rest], { cwd, stdout: "ignore", stderr: "pipe" });
  const res = { entry, runs: runs.length, medianMs: runs[2]!, minMs: runs[0]!, maxRssBytes: rss, cpuProfile: prof.exitCode === 0 && existsSync(out) ? out : null };
  if (log.json) { log.result(res); return 0; }
  log.info(`${c.bold("Profile")} ${entry}\n  wall (median of 5): ${c.cyan(fmtMs(res.medianMs))}  min ${fmtMs(res.minMs)}\n  peak RSS:           ${(rss / 1048576).toFixed(1)} MB`);
  log.info(res.cpuProfile ? `  CPU profile:        ${res.cpuProfile} ${c.dim("(open in Chrome DevTools → Performance)")}` : c.dim(`  CPU profile unavailable: ${prof.stderr.toString().split("\n")[0]}`));
  return 0;
}

async function deploy(cwd: string, f: Record<string, string | boolean>) {
  const { config, host } = await loadCtx(cwd);
  const { build, printBuild } = await import("../../bundler/src/index.ts");
  const r = await build({ config, host, force: true, compile: !!f.compile });
  printBuild(r);
  if (!r.ok) return 1;
  const df = join(cwd, "Dockerfile");
  if (!existsSync(df)) {
    const web = config.mode === "web";
    writeFileSync(df, `# Generated by aadi deploy
FROM oven/bun:1-slim AS base
WORKDIR /app
COPY ${config.outDir} ./${config.outDir}
COPY package.json ./
ENV NODE_ENV=production
EXPOSE 3000
USER bun
CMD [${web ? `"bunx", "--bun", "serve", "${config.outDir}", "-l", "3000"` : `"bun", "${config.outDir}/index.js"`}]
`);
    log.success("Wrote Dockerfile");
  }
  log.info(`\n${c.bold("Deploy artifacts ready")}\n  docker build -t ${basename(cwd)} . && docker run -p 3000:3000 ${basename(cwd)}${f.compile ? `\n  or ship the single binary: ${config.outDir}/app` : `\n  ${c.dim("tip: --compile produces a standalone executable")}`}`);
  return 0;
}

async function compat(write: boolean, withNode: boolean, filter?: string) {
  const probeFile = join(ROOT, "packages/node-compat/src/index.ts");
  const { runProbes, compatMarkdown } = await import("../../node-compat/src/index.ts");
  const t0 = performance.now();
  const results = await runProbes(filter);
  let nodeResults: Map<string, string> | undefined;
  if (withNode) {
    const p = Bun.spawnSync(["node", "--experimental-strip-types", "--no-warnings", probeFile, ...(filter ? [filter] : [])], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode === 0) nodeResults = new Map((JSON.parse(p.stdout.toString()) as any[]).map((r) => [r.module, r.status]));
    else log.warn(`Node comparison failed: ${p.stderr.toString().split("\n")[0]}`);
  }
  if (log.json) { log.result(results); }
  else {
    for (const r of results) {
      const icon = r.status === "pass" ? c.green("✓") : r.status === "missing" ? c.yellow("○") : c.red("✗");
      const node = nodeResults ? c.dim(` node:${nodeResults.get(r.module) ?? "?"}`) : "";
      log.info(`${icon} ${r.module.padEnd(24)} ${c.dim(fmtMs(r.ms).padStart(6))}${node}${r.error ? "  " + c.red(r.error) : ""}`);
    }
    const pass = results.filter((r) => r.status === "pass").length;
    log.info(`\n${c.bold(`${pass}/${results.length}`)} compatibility probes pass on Bun ${Bun.version} ${c.dim(`(${fmtMs(performance.now() - t0)})`)}`);
  }
  if (write) { writeFileSync(join(ROOT, "docs/COMPAT.md"), compatMarkdown(results, `Bun ${Bun.version}`)); log.success("Wrote docs/COMPAT.md"); }
  return results.every((r) => r.status === "pass") ? 0 : 1;
}

async function docsCmd(cwd: string, sub: string, port: number) {
  const { scanProject } = await import("../../ai/src/context.ts");
  const ctx = scanProject(cwd);
  const outDir = join(cwd, "docs");
  if (!existsSync(outDir)) Bun.spawnSync(["mkdir", "-p", outDir]);
  const apiMd = join(outDir, "API.md");
  const lines = [
    `# API Reference — ${ctx.package?.name ?? basename(cwd)}`,
    "",
    `Generated automatically by \`aadi docs\` using Bun's native AST scanner.`,
    "",
    "| Module | Size | Exported Symbols |",
    "|---|---|---|",
    ...ctx.files
      .filter((f) => f.exports && f.exports.length > 0)
      .map((f) => `| \`${f.path}\` | ${f.bytes} B | ${f.exports!.map((e) => `\`${e}\``).join(", ")} |`),
    "",
  ];
  writeFileSync(apiMd, lines.join("\n"));
  log.success(`Generated ${apiMd} (${ctx.files.filter((f) => f.exports?.length).length} modules documented)`);
  if (sub === "serve") {
    const { serveStatic } = await import("./static.ts");
    await serveStatic(outDir, port);
    await new Promise(() => {});
  }
  return 0;
}

function completion(shell: string) {
  const cmds = Object.keys(COMMANDS).join(" ");
  if (shell === "bash") return `_aadi(){ COMPREPLY=($(compgen -W "${cmds}" -- "\${COMP_WORDS[COMP_CWORD]}")); }\ncomplete -F _aadi aadi`;
  if (shell === "fish") return Object.entries(COMMANDS).map(([k, v]) => `complete -c aadi -n "__fish_use_subcommand" -a ${k} -d "${v.split("  ")[0]!.replace(/"/g, "")}"`).join("\n");
  return `#compdef aadi\n_aadi() {\n  local -a cmds\n  cmds=(\n${Object.entries(COMMANDS).map(([k, v]) => `    '${k}:${v.split("  ")[0]!.replace(/'/g, "")}'`).join("\n")}\n  )\n  _describe 'command' cmds\n}\ncompdef _aadi aadi`;
}
