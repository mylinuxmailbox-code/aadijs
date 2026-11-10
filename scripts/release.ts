#!/usr/bin/env bun
/**
 * Release & standalone binary build automation for AadiJS + Strato.
 * Usage:
 *   bun scripts/release.ts --binaries   # Compile standalone native `dist/aadi` and `dist/strato`
 *   bun scripts/release.ts --bump 0.2.0 # Bump version across root + all workspace packages
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { c, fmtBytes, fmtMs, parseArgs } from "../packages/utils/src/index.ts";
import { statSync } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");
const args = parseArgs(process.argv.slice(2), ["bump"]);

if (typeof args.flags.bump === "string") {
  const nextVer = args.flags.bump;
  const files = ["package.json", ...new Bun.Glob("packages/*/package.json").scanSync({ cwd: ROOT })];
  for (const rel of files) {
    const p = join(ROOT, rel);
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    pkg.version = nextVer;
    writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
  }
  console.log(`${c.green("✓")} Bumped ${files.length} package manifests to v${nextVer}`);
}

if (args.flags.binaries) {
  const outDir = join(ROOT, "dist");
  mkdirSync(outDir, { recursive: true });
  for (const [name, entry] of [
    ["aadi", "packages/cli/bin/aadi.ts"],
    ["strato", "packages/strato/bin/strato.ts"],
  ] as const) {
    const t0 = performance.now();
    const out = join(outDir, name);
    const p = Bun.spawnSync([process.execPath, "build", join(ROOT, entry), "--compile", "--minify", "--outfile", out], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) {
      console.error(`Failed to compile ${name}: ${p.stderr.toString()}`);
      process.exit(1);
    }
    console.log(`${c.green("✓")} Compiled ${c.bold(out)} (${fmtBytes(statSync(out).size)}) in ${fmtMs(performance.now() - t0)}`);
  }
}
