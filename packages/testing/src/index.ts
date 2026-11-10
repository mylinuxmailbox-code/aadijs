/**
 * @aadijs/testing — test runner front-end over `bun test` (Jest-compatible API, snapshots, mocks,
 * spies, coverage, watch) with AadiJS additions: process-level sharded parallelism and benchmarks.
 *
 * In test files:  import { test, expect, mock, spyOn, bench } from "aadijs/test";
 */
export * from "bun:test";
import { c, fmtMs, log } from "../../utils/src/index.ts";

export interface TestRunOptions {
  cwd: string; watch?: boolean; coverage?: boolean; parallel?: number | boolean;
  filter?: string; files?: string[]; timeout?: number; updateSnapshots?: boolean; bail?: boolean; extra?: string[];
}

export function bunTestArgs(o: TestRunOptions): string[] {
  const a = ["test"];
  if (o.watch) a.push("--watch");
  if (o.coverage) a.push("--coverage");
  if (o.filter) a.push("-t", o.filter);
  if (o.timeout) a.push("--timeout", String(o.timeout));
  if (o.updateSnapshots) a.push("--update-snapshots");
  if (o.bail) a.push("--bail");
  return [...a, ...(o.files ?? []), ...(o.extra ?? [])];
}

export function discoverTests(cwd: string, files: string[] = []): string[] {
  const glob = new Bun.Glob("**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mjs,cjs}");
  const all = [...glob.scanSync({ cwd })].filter((f) => !f.includes("node_modules/")).sort();
  return files.length ? all.filter((f) => files.some((x) => f.includes(x))) : all;
}

export async function runTests(o: TestRunOptions): Promise<number> {
  const workers = o.parallel === true ? navigator.hardwareConcurrency : typeof o.parallel === "number" ? o.parallel : 1;
  if (workers <= 1 || o.watch) {
    return await Bun.spawn([process.execPath, ...bunTestArgs(o)], { cwd: o.cwd, stdio: ["inherit", "inherit", "inherit"] }).exited;
  }
  // Shard files across isolated bun processes (each shard gets its own runtime → isolation preserved).
  const files = discoverTests(o.cwd, o.files);
  if (!files.length) { log.warn("No test files found"); return 1; }
  const n = Math.min(workers, files.length);
  const shards: string[][] = Array.from({ length: n }, () => []);
  files.forEach((f, i) => shards[i % n]!.push(f));
  const t0 = performance.now();
  log.info(c.dim(`Running ${files.length} test files across ${n} parallel workers…`));
  const results = await Promise.all(shards.map(async (shard, i) => {
    const p = Bun.spawn([process.execPath, ...bunTestArgs({ ...o, files: shard.map((f) => "./" + f) })], { cwd: o.cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, AADI_TEST_WORKER: String(i), FORCE_COLOR: process.stdout.isTTY ? "1" : "0" } });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out: out + err, code };
  }));
  let pass = 0, fail = 0;
  for (const r of results) {
    process.stdout.write(r.out);
    pass += Number(/(\d+) pass/.exec(r.out)?.[1] ?? 0);
    fail += Number(/(\d+) fail/.exec(r.out)?.[1] ?? 0);
  }
  const failed = results.some((r) => r.code !== 0);
  log.info(`\n${failed ? c.red("✗") : c.green("✓")} ${c.bold(`${pass} pass`)}, ${fail ? c.red(`${fail} fail`) : "0 fail"} across ${n} workers in ${fmtMs(performance.now() - t0)}`);
  return failed ? 1 : 0;
}

/** Micro-benchmark helper usable inside tests or scripts. Reports ops/sec with warmup. */
export async function bench(name: string, fn: () => unknown, { iterations = 0, timeMs = 500, warmup = 50 } = {}) {
  for (let i = 0; i < warmup; i++) await fn();
  const samples: number[] = [];
  const end = performance.now() + timeMs;
  let n = 0;
  while ((iterations && n < iterations) || (!iterations && performance.now() < end)) {
    const s = Bun.nanoseconds(); await fn(); samples.push(Bun.nanoseconds() - s); n++;
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const res = { name, iterations: n, meanNs: mean, p50Ns: samples[Math.floor(n * 0.5)]!, p99Ns: samples[Math.floor(n * 0.99)]!, opsPerSec: 1e9 / mean };
  console.log(`${c.cyan("bench")} ${name.padEnd(36)} ${res.opsPerSec.toFixed(0).padStart(12)} ops/s  p50 ${(res.p50Ns / 1000).toFixed(2)}µs  p99 ${(res.p99Ns / 1000).toFixed(2)}µs`);
  return res;
}
