/**
 * @aadijs/utils — zero-dependency terminal + process helpers shared by every subsystem.
 * Everything here is lazy and allocation-light: the CLI imports it on every invocation.
 */

const env = process.env;
const colorOn = !env.NO_COLOR && (env.FORCE_COLOR === "1" || !!process.stdout.isTTY);
const wrap = (open: number, close: number) => (s: string | number) =>
  colorOn ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);

export const c = {
  bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39),
  yellow: wrap(33, 39), blue: wrap(34, 39), magenta: wrap(35, 39), cyan: wrap(36, 39), gray: wrap(90, 39),
};

export type LogLevel = "silent" | "quiet" | "normal" | "verbose";

/** Structured logger. In JSON mode, human output is suppressed and only `result()` prints. */
export class Logger {
  level: LogLevel = "normal";
  json = false;
  info(...a: unknown[]) { if (!this.json && this.level !== "silent" && this.level !== "quiet") console.log(...a); }
  success(msg: string) { this.info(`${c.green("✓")} ${msg}`); }
  warn(msg: string) { if (!this.json && this.level !== "silent") console.error(`${c.yellow("⚠")} ${msg}`); }
  error(msg: string, hint?: string) {
    if (this.json) { console.log(JSON.stringify({ ok: false, error: msg, hint })); return; }
    console.error(`${c.red("✗")} ${msg}`);
    if (hint) console.error(`  ${c.dim("hint:")} ${hint}`);
  }
  debug(...a: unknown[]) { if (this.level === "verbose" && !this.json) console.error(c.gray("[debug]"), ...a); }
  result(data: unknown) { if (this.json) console.log(JSON.stringify(data, null, 2)); }
}
export const log = new Logger();

/** Error type carrying a user-facing hint and exit code. */
export class AadiError extends Error {
  constructor(message: string, public hint?: string, public exitCode = 1) { super(message); }
}

export interface ParsedArgs { _: string[]; flags: Record<string, string | boolean>; rest: string[] }

/** Minimal, fast argv parser. Supports --k=v, --k v (for known value flags), -abc, and `--` passthrough. */
export function parseArgs(argv: string[], valueFlags: string[] = []): ParsedArgs {
  const out: ParsedArgs = { _: [], flags: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { out.rest = argv.slice(i + 1); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const k = a.slice(2);
        if (k.startsWith("no-")) out.flags[k.slice(3)] = false;
        else if (valueFlags.includes(k) && i + 1 < argv.length) out.flags[k] = argv[++i]!;
        else out.flags[k] = true;
      }
    } else if (a.length > 1 && a[0] === "-" && !/^-\d/.test(a)) {
      for (const ch of a.slice(1)) out.flags[ch] = true;
    } else out._.push(a);
  }
  return out;
}

/** Simple promise-pool semaphore for bounded concurrency. */
export function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try { return await fn(); } finally { active--; queue.shift()?.(); }
  };
}

/** TTY spinner; no-op when not interactive (CI-friendly). */
export function spinner(text: string) {
  if (!process.stderr.isTTY || log.json || log.level === "quiet" || log.level === "silent") {
    return { update(_t: string) {}, stop(final?: string) { if (final) log.info(final); } };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0, cur = text;
  const t = setInterval(() => process.stderr.write(`\r${c.cyan(frames[i++ % frames.length]!)} ${cur}\x1b[K`), 80);
  return {
    update(t2: string) { cur = t2; },
    stop(final?: string) { clearInterval(t); process.stderr.write("\r\x1b[K"); if (final) log.info(final); },
  };
}

export const fmtMs = (ms: number) => (ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`);
export const fmtBytes = (b: number) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`;

/** Levenshtein distance for "did you mean" suggestions. */
export function suggest(input: string, options: string[]): string | undefined {
  let best: string | undefined, bestD = 3;
  for (const o of options) {
    const d = lev(input, o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}
function lev(a: string, b: string) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** Run a subprocess inheriting stdio; resolves with exit code. */
export async function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["inherit", "inherit", "inherit"] });
  return await p.exited;
}
