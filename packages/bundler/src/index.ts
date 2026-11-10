/**
 * @aadijs/bundler — production build engine on top of Bun.build.
 * Adds: config-driven defaults, env replacement, content-hash build cache (skips unchanged builds),
 * plugin hooks, bundle analysis and multiple output formats.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { AadiConfig } from "../../core/src/config.ts";
import { publicEnv } from "../../core/src/config.ts";
import type { PluginHost } from "../../plugins/src/index.ts";
import { AadiError, c, fmtBytes, fmtMs, log } from "../../utils/src/index.ts";

export interface BuildOptions {
  config: AadiConfig;
  host?: PluginHost;
  mode?: "production" | "development";
  watch?: boolean;
  force?: boolean;
  analyze?: boolean;
  /** Extra formats to emit alongside the primary format, e.g. ["cjs"] for libraries. */
  formats?: ("esm" | "cjs" | "iife")[];
  compile?: boolean;
}

export interface BuildResult {
  ok: boolean; cached: boolean; durationMs: number;
  outputs: { path: string; bytes: number; kind: string }[];
  logs: string[];
}

const SRC_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,css,html,json,svg,png,jpg,jpeg,gif,webp,woff,woff2}";

/** Fast content fingerprint of source inputs (size+mtime, no file reads) plus config and lockfile. */
export function inputHash(cfg: AadiConfig, extra = ""): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ build: cfg.build, entry: cfg.entry, mode: cfg.mode, extra }));
  const files = [...new Bun.Glob(SRC_GLOB).scanSync({ cwd: cfg.root })]
    .filter((f) => !f.startsWith("node_modules/") && !f.startsWith(cfg.outDir + "/") && !f.startsWith(".aadi/"))
    .sort();
  for (const f of files) { const s = statSync(join(cfg.root, f)); h.update(`${f}:${s.size}:${s.mtimeMs}\n`); }
  for (const lf of ["strato.lock", "bun.lock", "package.json"]) if (existsSync(join(cfg.root, lf))) h.update(readFileSync(join(cfg.root, lf)));
  return h.digest("hex");
}

export async function build(o: BuildOptions): Promise<BuildResult> {
  const cfg = o.config;
  const t0 = performance.now();
  const prod = (o.mode ?? "production") === "production";
  if (!cfg.entry) throw new AadiError("No entry point found", "Create index.html (web) or src/index.ts (server), or set `entry` in aadi.config.ts");
  const entry = join(cfg.root, cfg.entry);
  const outdir = join(cfg.root, cfg.outDir);
  const cacheFile = join(cfg.root, ".aadi", "build-cache.json");
  const hash = inputHash(cfg, `${prod}|${(o.formats ?? []).join(",")}|${!!o.compile}`);
  if (!o.force && existsSync(cacheFile) && existsSync(outdir)) {
    const prev = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (prev.hash === hash) return { ok: true, cached: true, durationMs: performance.now() - t0, outputs: prev.outputs, logs: [] };
  }
  await o.host?.emit("buildStart", { config: cfg, mode: o.mode });

  const target = cfg.mode === "server" && cfg.build.target === "browser" ? "bun" : cfg.build.target;
  if (o.compile) return compile(cfg, entry, t0);

  rmSync(outdir, { recursive: true, force: true });
  const define = { ...publicEnv(cfg.build.envPrefix), "process.env.NODE_ENV": JSON.stringify(prod ? "production" : "development"), ...cfg.build.define };
  const formats = [cfg.build.format, ...(o.formats ?? []).filter((f) => f !== cfg.build.format)];
  const outputs: BuildResult["outputs"] = [];
  const logs: string[] = [];
  // Formats build in parallel.
  const results = await Promise.all(formats.map((format, i) => Bun.build({
    entrypoints: [entry],
    outdir: i === 0 ? outdir : join(outdir, format),
    target, format,
    minify: prod && cfg.build.minify,
    sourcemap: cfg.build.sourcemap,
    splitting: format === "esm" && cfg.build.splitting,
    external: cfg.build.external,
    define,
    plugins: o.host?.bunPlugins ?? [],
    naming: cfg.mode === "web" ? { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" } : undefined,
    throw: false,
  })));
  let ok = true;
  for (const r of results) {
    ok &&= r.success;
    for (const m of r.logs) logs.push(String(m));
    for (const out of r.outputs) outputs.push({ path: relative(cfg.root, out.path), bytes: out.size, kind: out.kind });
  }
  const res: BuildResult = { ok, cached: false, durationMs: performance.now() - t0, outputs, logs };
  await o.host?.emit("buildEnd", res);
  if (ok) {
    mkdirSync(join(cfg.root, ".aadi"), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ hash, outputs }));
  }
  return res;
}

async function compile(cfg: AadiConfig, entry: string, t0: number): Promise<BuildResult> {
  mkdirSync(join(cfg.root, cfg.outDir), { recursive: true });
  const out = join(cfg.root, cfg.outDir, "app");
  const p = Bun.spawnSync([process.execPath, "build", entry, "--compile", "--minify", "--outfile", out], { cwd: cfg.root, stderr: "pipe", stdout: "pipe" });
  const ok = p.exitCode === 0;
  return { ok, cached: false, durationMs: performance.now() - t0, outputs: ok ? [{ path: relative(cfg.root, out), bytes: statSync(out).size, kind: "executable" }] : [], logs: ok ? [] : [p.stderr.toString()] };
}

export function printBuild(r: BuildResult, analyze = false) {
  if (!r.ok) { for (const l of r.logs) log.error(l); return; }
  if (r.cached) { log.success(`Build up to date ${c.dim("(cache hit, " + fmtMs(r.durationMs) + ")")}`); return; }
  const outs = [...r.outputs].sort((a, b) => b.bytes - a.bytes);
  const total = outs.reduce((s, o) => s + o.bytes, 0);
  const show = analyze ? outs : outs.filter((o) => !o.path.endsWith(".map")).slice(0, 12);
  for (const o of show) {
    const bar = analyze ? " " + c.cyan("█".repeat(Math.max(1, Math.round((o.bytes / total) * 30)))) : "";
    log.info(`  ${c.dim(o.kind.padEnd(10))} ${o.path.padEnd(48)} ${fmtBytes(o.bytes).padStart(10)}${bar}`);
  }
  if (!analyze && outs.length > show.length) log.info(c.dim(`  … ${outs.length - show.length} more (use --analyze)`));
  for (const l of r.logs) log.warn(l);
  log.success(`Built ${outs.length} files (${fmtBytes(total)}) in ${c.cyan(fmtMs(r.durationMs))}`);
}

/** Watch mode: rebuild on change (debounced). */
export async function watchBuild(o: BuildOptions) {
  const { watch } = await import("node:fs");
  printBuild(await build(o));
  let timer: Timer | undefined;
  watch(o.config.root, { recursive: true }, (_e, file) => {
    if (!file || /node_modules|\.aadi|\.git/.test(file) || file.startsWith(o.config.outDir)) return;
    clearTimeout(timer);
    timer = setTimeout(async () => { log.info(c.dim(`↻ ${file}`)); printBuild(await build({ ...o, force: true })); }, 30);
  });
  log.info(c.dim("Watching for changes…"));
  await new Promise(() => {});
}
