/**
 * @aadijs/dev-server
 * - web mode: Bun.serve with native HTML imports → on-demand bundling, real HMR + React Fast Refresh,
 *   browser error overlay (all Bun-native), plus AadiJS proxy, auto port, HTTPS, and plugin hooks.
 * - server mode: runs the entry under `bun --hot` (in-place module hot reload, state preserved).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AadiConfig } from "../../core/src/config.ts";
import type { PluginHost } from "../../plugins/src/index.ts";
import { AadiError, c, fmtMs, log } from "../../utils/src/index.ts";

/** Pre-bundle direct dependencies into .aadi/deps as browser-ready ESM chunks when lockfile/package.json changes. */
export async function prebundleDeps(root: string): Promise<{ prebundled: number; cached: boolean }> {
  const pjPath = join(root, "package.json");
  if (!existsSync(pjPath)) return { prebundled: 0, cached: true };
  const pkg = JSON.parse(readFileSync(pjPath, "utf8"));
  const deps = Object.keys(pkg.dependencies ?? {}).filter((d) => existsSync(join(root, "node_modules", d)));
  if (!deps.length) return { prebundled: 0, cached: true };

  const outDir = join(root, ".aadi", "deps");
  const metaFile = join(outDir, "_meta.json");
  const sig = createHash("sha256")
    .update(JSON.stringify(pkg.dependencies))
    .update(existsSync(join(root, "strato.lock")) ? readFileSync(join(root, "strato.lock")) : "")
    .digest("hex");

  if (existsSync(metaFile)) {
    try {
      if (JSON.parse(readFileSync(metaFile, "utf8")).sig === sig) return { prebundled: deps.length, cached: true };
    } catch {}
  }
  mkdirSync(outDir, { recursive: true });
  const entrypoints = deps.map((d) => {
    try { return Bun.resolveSync(d, root); } catch { return ""; }
  }).filter(Boolean);

  if (entrypoints.length) {
    await Bun.build({ entrypoints, outdir: outDir, target: "browser", format: "esm", splitting: true, minify: false, throw: false });
  }
  writeFileSync(metaFile, JSON.stringify({ sig, deps }));
  return { prebundled: entrypoints.length, cached: false };
}

export async function findPort(start: number, host: string): Promise<number> {
  for (let p = start; p < start + 50; p++) {
    try { const s = Bun.listen({ hostname: host, port: p, socket: { data() {} } }); s.stop(true); return p; }
    catch { /* in use */ }
  }
  throw new AadiError(`No free port found in ${start}-${start + 49}`);
}

export async function startDev(cfg: AadiConfig, host?: PluginHost, opts: { port?: number } = {}) {
  const t0 = performance.now();
  await host?.emit("devStart", { config: cfg });
  if (cfg.mode === "server") return runServerMode(cfg);

  const pb = await prebundleDeps(cfg.root);
  if (pb.prebundled && !pb.cached) log.debug(`Pre-bundled ${pb.prebundled} dependencies into .aadi/deps`);

  if (!cfg.entry) throw new AadiError("No index.html found", "Create index.html or set mode: 'server' in aadi.config.ts");
  const html = (await import(join(cfg.root, cfg.entry))).default;
  const port = await findPort(opts.port ?? cfg.dev.port, cfg.dev.host);
  const proxies = Object.entries(cfg.dev.proxy).sort((a, b) => b[0].length - a[0].length);
  const publicDir = join(cfg.root, "public");

  const server = Bun.serve({
    port, hostname: cfg.dev.host,
    development: { hmr: true, console: true },
    tls: cfg.dev.https ? { cert: Bun.file(cfg.dev.https.cert), key: Bun.file(cfg.dev.https.key) } : undefined,
    routes: { "/": html },
    async fetch(req) {
      const url = new URL(req.url);
      for (const [prefix, target] of proxies) {
        if (url.pathname.startsWith(prefix)) {
          const dest = new URL(url.pathname + url.search, target);
          const headers = new Headers(req.headers); headers.set("host", dest.host);
          return fetch(dest, { method: req.method, headers, body: req.body, redirect: "manual" });
        }
      }
      const pf = join(publicDir, decodeURIComponent(url.pathname));
      if (pf.startsWith(publicDir) && existsSync(pf) && Bun.file(pf).size >= 0) {
        const f = Bun.file(pf);
        if (await f.exists()) return new Response(f);
      }
      // SPA fallback: unknown non-asset routes render the app shell
      if (!/\.\w+$/.test(url.pathname) && req.method === "GET") return Response.redirect("/", 302);
      return new Response("Not found", { status: 404 });
    },
  });
  const proto = cfg.dev.https ? "https" : "http";
  log.info(`\n  ${c.bold(c.cyan("⚡ AadiJS"))} ${c.dim("dev server ready in")} ${c.bold(fmtMs(performance.now() - t0))}\n`);
  log.info(`  ${c.green("➜")}  Local:   ${c.cyan(`${proto}://${cfg.dev.host}:${server.port}/`)}`);
  if (port !== cfg.dev.port) log.info(`  ${c.yellow("➜")}  Port ${cfg.dev.port} busy — using ${port}`);
  for (const [p, t] of proxies) log.info(`  ${c.dim("➜")}  Proxy:   ${p} → ${t}`);
  log.info(`  ${c.dim("➜")}  HMR + Fast Refresh enabled\n`);
  return server;
}

async function runServerMode(cfg: AadiConfig): Promise<never> {
  if (!cfg.entry) throw new AadiError("No server entry found", "Create src/index.ts or set `entry` in aadi.config.ts");
  log.info(`${c.bold(c.cyan("⚡ AadiJS"))} ${c.dim("server mode — hot reloading")} ${cfg.entry}`);
  const p = Bun.spawn([process.execPath, "--hot", cfg.entry], {
    cwd: cfg.root, stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, NODE_ENV: "development", PORT: String(cfg.dev.port) },
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => p.kill(sig));
  process.exit(await p.exited);
}
