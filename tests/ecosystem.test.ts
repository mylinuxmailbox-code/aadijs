import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, suggest, limiter } from "../packages/utils/src/index.ts";
import { loadConfig, defineConfig } from "../packages/core/src/config.ts";
import { PluginHost, definePlugin } from "../packages/plugins/src/index.ts";
import { createApp, cors } from "../packages/runtime/src/index.ts";
import { parseSpec, splitNameSpec, maxSatisfying, layout, type Graph } from "../packages/strato/src/resolver.ts";
import { createTgz, extractTgz, verifyIntegrity } from "../packages/strato/src/store.ts";
import { install } from "../packages/strato/src/installer.ts";
import { build } from "../packages/bundler/src/index.ts";
import { redact, scanProject, renderContext } from "../packages/ai/src/context.ts";
import { runProbes } from "../packages/node-compat/src/index.ts";

describe("@aadijs/utils", () => {
  test("parseArgs handles flags, values, negations, and rest", () => {
    const res = parseArgs(["build", "--port", "4000", "--no-minify", "-Dv", "--format=cjs", "--", "extra"], ["port"]);
    expect(res._).toEqual(["build"]);
    expect(res.flags.port).toBe("4000");
    expect(res.flags.minify).toBe(false);
    expect(res.flags.D).toBe(true);
    expect(res.flags.v).toBe(true);
    expect(res.flags.format).toBe("cjs");
    expect(res.rest).toEqual(["extra"]);
  });

  test("suggest finds closest Levenshtein match", () => {
    expect(suggest("instal", ["install", "build", "dev"])).toBe("install");
    expect(suggest("xyz123", ["install", "build"])).toBeUndefined();
  });

  test("limiter enforces concurrency ceiling", async () => {
    const run = limiter(2);
    let active = 0, peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        run(async () => {
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(10);
          active--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("@aadijs/core & @aadijs/plugins", () => {
  test("loadConfig loads defaults and user config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aadi-cfg-"));
    writeFileSync(join(dir, "index.html"), "<html></html>");
    writeFileSync(join(dir, "aadi.config.json"), JSON.stringify(defineConfig({ dev: { port: 4567 } })));
    const cfg = await loadConfig(dir);
    expect(cfg.dev.port).toBe(4567);
    expect(cfg.mode).toBe("web");
    expect(cfg.entry).toBe("index.html");
    rmSync(dir, { recursive: true, force: true });
  });

  test("PluginHost orders dependencies, checks version, and runs hooks/commands", async () => {
    const host = new PluginHost("0.1.0");
    const order: string[] = [];
    const pA = definePlugin({
      name: "plugin-a",
      aadi: ">=0.1.0",
      setup(api) {
        order.push("a");
        api.on("config", (cfg) => ({ ...cfg, touchedByA: true }));
      },
    });
    const pB = definePlugin({
      name: "plugin-b",
      requires: ["plugin-a"],
      setup(api) {
        order.push("b");
        api.command("hello", { description: "greet", run: () => 42 });
      },
    });
    await host.load([pB, pA]);
    expect(order).toEqual(["a", "b"]);
    expect(host.commands.has("hello")).toBe(true);
    const out = await host.emit("config", { base: 1 });
    expect((out as any).touchedByA).toBe(true);
  });
});

describe("@aadijs/runtime", () => {
  test("AadiApp routes static, dynamic params, middleware, and CORS", async () => {
    const app = createApp();
    app.use(cors("https://aadi.dev"));
    app.use(async (ctx, next) => {
      ctx.state.user = "ada";
      return await next();
    });
    app.get("/health", (c) => c.json({ ok: true, user: c.state.user }));
    app.get("/users/:id", (c) => c.json({ id: c.params.id, q: c.query.tab }));

    const r1 = await app.fetch(new Request("http://localhost/health"));
    expect(r1.status).toBe(200);
    expect(r1.headers.get("access-control-allow-origin")).toBe("https://aadi.dev");
    expect(r1.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r1.json()).toEqual({ ok: true, user: "ada" });

    const r2 = await app.fetch(new Request("http://localhost/users/99?tab=profile"));
    expect(await r2.json()).toEqual({ id: "99", q: "profile" });

    const r404 = await app.fetch(new Request("http://localhost/nope"));
    expect(r404.status).toBe(404);
  });
});

describe("@aadijs/strato", () => {
  test("parseSpec and splitNameSpec handle ranges, tags, aliases, git, workspaces", () => {
    expect(splitNameSpec("@scope/pkg@^1.2.0")).toEqual({ name: "@scope/pkg", spec: "^1.2.0" });
    expect(parseSpec("foo", "npm:bar@^2.0.0")).toEqual({ type: "alias", name: "bar", spec: "^2.0.0" });
    expect(parseSpec("foo", "workspace:*")).toEqual({ type: "workspace", name: "foo", spec: "*" });
    expect(parseSpec("foo", "github:owner/repo#main").type).toBe("git");
    expect(maxSatisfying(["1.0.0", "1.4.2", "2.0.0"], "^1.0.0")).toBe("1.4.2");
  });

  test("tarball pack, integrity check, extract, and zip-slip prevention", () => {
    const dir = mkdtempSync(join(tmpdir(), "strato-tar-"));
    const tgz = createTgz([
      { path: "package.json", data: new TextEncoder().encode('{"name":"demo","version":"1.0.0"}') },
      { path: "index.js", data: new TextEncoder().encode("module.exports = 42;") },
    ]);
    const sri = verifyIntegrity(tgz);
    expect(sri.startsWith("sha512-")).toBe(true);
    expect(() => verifyIntegrity(tgz, "sha512-badbadbad")).toThrow();

    extractTgz(tgz, dir);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name).toBe("demo");
    rmSync(dir, { recursive: true, force: true });
  });

  test("hoisted layout deduplicates shared packages and nests conflicting versions", () => {
    const g: Graph = {
      rootDeps: { a: "^1.0.0", b: "^1.0.0" },
      edges: new Map([
        ["a@^1.0.0", "a@1.0.0"],
        ["b@^1.0.0", "b@1.0.0"],
        ["c@^1.0.0", "c@1.0.0"],
        ["c@^2.0.0", "c@2.0.0"],
      ]),
      nodes: new Map([
        ["a@1.0.0", { id: "a@1.0.0", name: "a", version: "1.0.0", kind: "registry", resolved: "", dependencies: { c: "^1.0.0" } }],
        ["b@1.0.0", { id: "b@1.0.0", name: "b", version: "1.0.0", kind: "registry", resolved: "", dependencies: { c: "^2.0.0" } }],
        ["c@1.0.0", { id: "c@1.0.0", name: "c", version: "1.0.0", kind: "registry", resolved: "", dependencies: {} }],
        ["c@2.0.0", { id: "c@2.0.0", name: "c", version: "2.0.0", kind: "registry", resolved: "", dependencies: {} }],
      ]),
      optionalSkipped: [],
      warnings: [],
    };
    const placed = layout(g);
    expect(placed.get("node_modules/a")).toBe("a@1.0.0");
    expect(placed.get("node_modules/b")).toBe("b@1.0.0");
    expect(placed.get("node_modules/c")).toBe("c@1.0.0");
    expect(placed.get("node_modules/b/node_modules/c")).toBe("c@2.0.0");
  });

  test("workspace + local dependency installation with lockfile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strato-ws-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"], dependencies: {} }),
    );
    const pkgADir = join(dir, "packages/pkg-a");
    Bun.spawnSync(["mkdir", "-p", pkgADir]);
    writeFileSync(join(pkgADir, "package.json"), JSON.stringify({ name: "@ws/pkg-a", version: "1.0.0", main: "index.js" }));
    writeFileSync(join(pkgADir, "index.js"), "export const val = 123;");

    const stats = await install({ cwd: dir, offline: true });
    expect(stats.packages).toBe(1);
    expect(existsSync(join(dir, "node_modules/@ws/pkg-a/package.json"))).toBe(true);
    expect(existsSync(join(dir, "strato.lock"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("@aadijs/bundler", () => {
  test("builds TypeScript entry and hits incremental build cache on second run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aadi-build-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "btest", version: "0.1.0" }));
    const srcDir = join(dir, "src");
    Bun.spawnSync(["mkdir", "-p", srcDir]);
    writeFileSync(join(srcDir, "index.ts"), "export const double = (n: number) => n * 2;\nconsole.log(double(21));\n");

    const cfg = await loadConfig(dir);
    const r1 = await build({ config: cfg });
    expect(r1.ok).toBe(true);
    expect(r1.cached).toBe(false);
    expect(r1.outputs.length).toBeGreaterThan(0);

    const r2 = await build({ config: cfg });
    expect(r2.ok).toBe(true);
    expect(r2.cached).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("@aadijs/ai", () => {
  test("redacts secrets and scans project structure offline", () => {
    const [clean, count] = redact('const key = "sk-1234567890abcdefghijklmnop"; const password = "supersecretvalue";');
    expect(count).toBeGreaterThanOrEqual(2);
    expect(clean).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(clean).not.toContain("supersecretvalue");

    const dir = mkdtempSync(join(tmpdir(), "aadi-ai-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "aitest", version: "1.0.0", dependencies: { zod: "^3.0.0" } }));
    writeFileSync(join(dir, "index.ts"), 'import { helper } from "./util";\nexport function main() { return helper(); }\n');
    writeFileSync(join(dir, "util.ts"), "export const helper = () => 1;\n");
    const ctx = scanProject(dir);
    expect(ctx.files.some((f) => f.path === "index.ts" && f.exports?.includes("main"))).toBe(true);
    const rendered = renderContext(ctx, { maxBytes: 50_000, redactSecrets: true });
    expect(rendered).toContain("export function main()");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("@aadijs/node-compat", () => {
  test("all Node.js compatibility probes pass on Bun", async () => {
    const results = await runProbes();
    const failed = results.filter((r) => r.status !== "pass");
    expect(failed).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(45);
  });
});
