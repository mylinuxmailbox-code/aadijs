/**
 * @aadijs/core — configuration engine.
 * Loads aadi.config.{ts,js,mjs,json} (first match), merges with defaults, validates.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AadiError } from "../../utils/src/index.ts";
import type { AadiPlugin } from "../../plugins/src/index.ts";

export interface AadiConfig {
  root: string;
  /** "web" serves index.html with HMR; "server" runs an entry with bun --hot. Auto-detected if omitted. */
  mode?: "web" | "server";
  entry?: string;
  outDir: string;
  dev: { port: number; host: string; https?: { cert: string; key: string }; proxy: Record<string, string>; open?: boolean };
  build: {
    minify: boolean; sourcemap: "none" | "linked" | "inline" | "external"; splitting: boolean;
    format: "esm" | "cjs" | "iife"; target: "browser" | "bun" | "node"; external: string[];
    define: Record<string, string>; envPrefix: string;
  };
  test: { dir?: string; timeout?: number };
  ai: {
    provider?: "openai" | "anthropic" | "google" | "ollama";
    model?: string;
    /** Allow AI to write files (always asks for confirmation unless --yes). */
    allowWrite: boolean;
    /** Redact secrets/env-like values before sending context. */
    redact: boolean;
    /** Globs never sent to a provider. */
    exclude: string[];
    maxContextBytes: number;
  };
  plugins: AadiPlugin[];
}

export type UserConfig = Partial<Omit<AadiConfig, "dev" | "build" | "ai" | "test">> & {
  dev?: Partial<AadiConfig["dev"]>; build?: Partial<AadiConfig["build"]>;
  ai?: Partial<AadiConfig["ai"]>; test?: Partial<AadiConfig["test"]>;
};

/** Typed helper for aadi.config.ts */
export const defineConfig = (c: UserConfig) => c;

export const CONFIG_FILES = ["aadi.config.ts", "aadi.config.js", "aadi.config.mjs", "aadi.config.json"];

export function defaults(root: string): AadiConfig {
  return {
    root, outDir: "dist",
    dev: { port: 3000, host: "localhost", proxy: {} },
    build: { minify: true, sourcemap: "linked", splitting: true, format: "esm", target: "browser", external: [], define: {}, envPrefix: "AADI_PUBLIC_" },
    test: {},
    ai: { allowWrite: true, redact: true, exclude: [".env*", "**/*.pem", "**/*.key", "**/secrets/**"], maxContextBytes: 120_000 },
    plugins: [],
  };
}

export async function loadConfig(cwd = process.cwd()): Promise<AadiConfig> {
  const root = resolve(cwd);
  const base = defaults(root);
  let user: UserConfig = {};
  for (const f of CONFIG_FILES) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    try {
      user = f.endsWith(".json") ? await Bun.file(p).json() : ((await import(p)).default ?? {});
    } catch (e) {
      throw new AadiError(`Failed to load ${f}: ${(e as Error).message}`, "Check the config file for syntax errors.");
    }
    break;
  }
  const cfg: AadiConfig = {
    ...base, ...user, root,
    dev: { ...base.dev, ...user.dev },
    build: { ...base.build, ...user.build },
    ai: { ...base.ai, ...user.ai },
    test: { ...base.test, ...user.test },
    plugins: user.plugins ?? [],
  };
  validate(cfg);
  if (!cfg.mode) cfg.mode = existsSync(join(root, "index.html")) || existsSync(join(root, "public/index.html")) ? "web" : "server";
  if (!cfg.entry) cfg.entry = detectEntry(root, cfg.mode);
  return cfg;
}

function validate(c: AadiConfig) {
  if (!Number.isInteger(c.dev.port) || c.dev.port < 0 || c.dev.port > 65535) throw new AadiError(`Invalid dev.port: ${c.dev.port}`);
  if (!["esm", "cjs", "iife"].includes(c.build.format)) throw new AadiError(`Invalid build.format: ${c.build.format}`, "Use esm, cjs or iife.");
  if (!Array.isArray(c.plugins)) throw new AadiError("`plugins` must be an array");
}

function detectEntry(root: string, mode: "web" | "server") {
  const cands = mode === "web"
    ? ["index.html", "public/index.html"]
    : ["src/index.ts", "src/index.tsx", "src/server.ts", "index.ts", "src/index.js", "index.js", "server.ts", "server.js"];
  return cands.find((x) => existsSync(join(root, x)));
}

/** Load .env files with Bun semantics (Bun already loads .env for the process; this is for explicit consumers). */
export function publicEnv(prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith(prefix) && v !== undefined) out[`process.env.${k}`] = JSON.stringify(v);
  out["process.env.NODE_ENV"] = JSON.stringify(process.env.NODE_ENV ?? "production");
  return out;
}
