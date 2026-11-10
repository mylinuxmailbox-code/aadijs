/**
 * Aadi AI — project understanding. Builds a compact, privacy-filtered context of a project:
 * file tree, package + dependency graph summary, exported symbols (via Bun.Transpiler.scan),
 * and selected file contents within a byte budget. Works fully offline — no LLM required.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".css", ".html", ".vue", ".svelte"]);
const ALWAYS_IGNORE = /(^|\/)(node_modules|\.git|dist|build|\.aadi|\.next|coverage|\.strato)(\/|$)/;

export interface ProjectContext {
  root: string;
  package?: { name?: string; version?: string; scripts?: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
  files: { path: string; bytes: number; exports?: string[]; imports?: string[] }[];
  /** internal import graph: file -> local files it imports */
  graph: Record<string, string[]>;
  redactions: number;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g, // OpenAI-style
  /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g, // AWS access key
  /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\b/g,
  /\b(AIza[0-9A-Za-z_-]{35})\b/g, // Google API key
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, // Slack
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /((?:password|passwd|secret|api[_-]?key|token|auth)["']?\s*[:=]\s*["'])([^"'\s]{8,})(["'])/gi,
];

/** Redact likely secrets. Returns [text, count]. */
export function redact(text: string): [string, number] {
  let n = 0;
  for (const re of SECRET_PATTERNS) text = text.replace(re, (...m) => { n++; return m.length > 5 && typeof m[2] === "string" && typeof m[3] === "string" && m[1]?.match(/[:=]/) ? `${m[1]}[REDACTED]${m[3]}` : "[REDACTED]"; });
  return [text, n];
}

function globToRe(g: string) {
  return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".") + "$");
}

export function scanProject(root: string, exclude: string[] = []): ProjectContext {
  const ex = exclude.map(globToRe);
  const isExcluded = (p: string) => ALWAYS_IGNORE.test(p) || ex.some((r) => r.test(p) || r.test(p.split("/").pop()!));
  const ctx: ProjectContext = { root, files: [], graph: {}, redactions: 0 };
  if (existsSync(join(root, "package.json"))) {
    const p = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    ctx.package = { name: p.name, version: p.version, scripts: p.scripts, dependencies: p.dependencies ?? {}, devDependencies: p.devDependencies ?? {} };
  }
  const tsx = new Bun.Transpiler({ loader: "tsx" });
  for (const f of new Bun.Glob("**/*").scanSync({ cwd: root, dot: false })) {
    if (isExcluded(f) || !CODE_EXT.has(extname(f))) continue;
    const full = join(root, f);
    const bytes = statSync(full).size;
    const entry: ProjectContext["files"][number] = { path: f, bytes };
    if (/\.(m|c)?[jt]sx?$/.test(f) && bytes < 500_000) {
      try {
        const scan = tsx.scan(readFileSync(full, "utf8"));
        entry.exports = scan.exports;
        entry.imports = scan.imports.map((i) => i.path);
        const local = entry.imports.filter((i) => i.startsWith("."));
        if (local.length) ctx.graph[f] = local;
      } catch { /* unparsable file: still listed */ }
    }
    ctx.files.push(entry);
  }
  ctx.files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return ctx;
}

/** Render the context as a prompt section, adding selected file contents up to maxBytes. */
export function renderContext(ctx: ProjectContext, opts: { focus?: string[]; maxBytes: number; redactSecrets: boolean; exclude?: string[] }): string {
  const parts: string[] = [];
  if (ctx.package) {
    parts.push(`## package.json\nname: ${ctx.package.name}@${ctx.package.version}\nscripts: ${JSON.stringify(ctx.package.scripts ?? {})}\ndependencies: ${JSON.stringify(ctx.package.dependencies)}\ndevDependencies: ${JSON.stringify(ctx.package.devDependencies)}`);
  }
  parts.push("## Files\n" + ctx.files.map((f) => `${f.path} (${f.bytes}B)${f.exports?.length ? " exports: " + f.exports.join(", ") : ""}`).join("\n"));
  let used = parts.join("\n").length;
  const focus = new Set(opts.focus ?? []);
  // Prioritize focused files, then their local imports, then small entry-like files.
  const order = [
    ...ctx.files.filter((f) => focus.has(f.path)),
    ...ctx.files.filter((f) => !focus.has(f.path) && [...focus].some((x) => ctx.graph[x]?.some((i) => f.path.includes(i.replace(/^\.\//, "").replace(/\.\w+$/, ""))))),
    ...ctx.files.filter((f) => !focus.has(f.path) && /(^|\/)(index|main|app|server)\.\w+$/.test(f.path)),
  ];
  const seen = new Set<string>();
  for (const f of order) {
    if (seen.has(f.path) || f.path.endsWith(".json") && f.path !== "package.json" && !focus.has(f.path)) continue;
    seen.add(f.path);
    let txt = readFileSync(join(ctx.root, f.path), "utf8");
    if (opts.redactSecrets) { const [t, n] = redact(txt); txt = t; ctx.redactions += n; }
    const block = `\n## ${f.path}\n\`\`\`\n${txt}\n\`\`\``;
    if (used + block.length > opts.maxBytes) continue;
    parts.push(block); used += block.length;
  }
  return parts.join("\n");
}
