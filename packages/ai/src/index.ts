/**
 * Aadi AI — commands. Optional by design: nothing else in AadiJS depends on an LLM.
 * Writes always show a diff-ish preview and require confirmation (unless --yes and ai.allowWrite).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { AadiConfig } from "../../core/src/config.ts";
import type { PluginHost } from "../../plugins/src/index.ts";
import { AadiError, c, log, spinner } from "../../utils/src/index.ts";
import { pickProvider, type ChatMessage } from "./providers.ts";
import { renderContext, scanProject } from "./context.ts";

export * from "./providers.ts";
export * from "./context.ts";

const SYSTEM = `You are Aadi AI, the assistant built into the AadiJS framework (Bun-powered JavaScript/TypeScript).
Be precise and concise. Prefer Bun-native APIs. When asked to produce a file, respond with ONLY the file contents in a single fenced code block.`;

const HELP = `${c.bold("aadi ai")} — AI-native development (optional; requires a provider key or local Ollama)

  aadi ai context [files…]        Show the project context that would be sent (offline, no LLM)
  aadi ai ask "<question>"        Ask about this codebase
  aadi ai explain <file>          Explain a file
  aadi ai review <file>           Find bugs & performance issues
  aadi ai test <file>             Generate a test file (writes <file>.test.ts after approval)
  aadi ai docs <file>             Generate documentation
  aadi ai gen <out-file> "<spec>" Generate a component/module/API
  aadi ai fix [-- cmd]            Run a failing command (default: aadi build), diagnose the error
  aadi ai deps                    Dependency update suggestions

  Options: --provider openai|anthropic|google|ollama  --model <id>  --yes  --no-redact
  Env:     OPENAI_API_KEY | ANTHROPIC_API_KEY | GEMINI_API_KEY | OLLAMA_HOST`;

export async function aiMain(args: string[], flags: Record<string, string | boolean>, rest: string[], cfg: AadiConfig, host?: PluginHost): Promise<number> {
  const [sub, ...params] = args;
  if (!sub || sub === "help") { console.log(HELP); return 0; }
  const redactOn = flags.redact !== false && cfg.ai.redact;
  const ctx = scanProject(cfg.root, cfg.ai.exclude);
  const contextFor = (focus: string[] = []) => renderContext(ctx, { focus, maxBytes: cfg.ai.maxContextBytes, redactSecrets: redactOn });

  if (sub === "context") {
    const text = contextFor(params);
    if (log.json) log.result({ files: ctx.files.length, bytes: text.length, redactions: ctx.redactions, graph: ctx.graph });
    else { console.log(text); log.info(c.dim(`\n— ${ctx.files.length} files indexed, ${text.length} bytes of context, ${ctx.redactions} secrets redacted`)); }
    return 0;
  }

  const provider = pickProvider((flags.provider as string) ?? cfg.ai.provider);
  if (!provider) throw new AadiError("No AI provider configured", "Set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY, or use --provider ollama for a local model.");
  const model = (flags.model as string) ?? cfg.ai.model;
  const ask = async (prompt: string, focus: string[] = []) => {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM + (host?.aiTools.length ? `\nAvailable project tools: ${host.aiTools.map((t) => `${t.name}: ${t.description}`).join("; ")}` : "") },
      { role: "user", content: `# Project context\n${contextFor(focus)}\n\n# Task\n${prompt}` },
    ];
    const sp = spinner(`Thinking with ${provider.name}…`);
    try { return await provider.chat(messages, { model }); } finally { sp.stop(); }
  };
  const need = (f?: string) => {
    if (!f) throw new AadiError(`Usage: aadi ai ${sub} <file>`);
    if (!existsSync(join(cfg.root, f))) throw new AadiError(`File not found: ${f}`);
    return relative(cfg.root, join(cfg.root, f));
  };

  switch (sub) {
    case "ask": console.log(await ask(params.join(" ") || "Summarize this project.")); return 0;
    case "explain": { const f = need(params[0]); console.log(await ask(`Explain ${f}: purpose, how it works, and how it fits in the project.`, [f])); return 0; }
    case "review": { const f = need(params[0]); console.log(await ask(`Review ${f} for bugs, security issues and performance optimizations. List concrete findings with line references and fixes.`, [f])); return 0; }
    case "docs": { const f = need(params[0]); console.log(await ask(`Write Markdown API documentation for the public exports of ${f}.`, [f])); return 0; }
    case "deps": console.log(await ask("Review the dependencies. Suggest updates, lighter or Bun-native replacements, and flag risky packages.")); return 0;
    case "test": {
      const f = need(params[0]);
      const out = f.replace(/\.(m|c)?[jt]sx?$/, "") + ".test.ts";
      const code = extractCode(await ask(`Write a comprehensive test file for ${f} using \`import { test, expect, describe, mock } from "bun:test"\`. Import from "./${f.split("/").pop()}". Output only the file.`, [f]));
      return await writeWithApproval(cfg, out, code, !!flags.yes);
    }
    case "gen": case "generate": {
      const [out, ...spec] = params;
      if (!out || !spec.length) throw new AadiError('Usage: aadi ai gen <out-file> "<description>"');
      const code = extractCode(await ask(`Create the file ${out}: ${spec.join(" ")}. Follow the project's conventions. Output only the file.`));
      return await writeWithApproval(cfg, out, code, !!flags.yes);
    }
    case "fix": {
      const cmd = rest.length ? rest : [process.execPath, join(import.meta.dir, "../../cli/bin/aadi.ts"), "build"];
      log.info(c.dim(`$ ${cmd.join(" ")}`));
      const p = Bun.spawnSync(cmd, { cwd: cfg.root, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode === 0) { log.success("Command succeeded — nothing to fix"); return 0; }
      const output = (p.stdout.toString() + "\n" + p.stderr.toString()).slice(-12_000);
      const files = [...new Set([...output.matchAll(/([\w./-]+\.(?:m|c)?[jt]sx?)(?::\d+)/g)].map((m) => m[1]!).filter((f) => existsSync(join(cfg.root, f))))];
      console.log(await ask(`This command failed:\n$ ${cmd.join(" ")}\n\n\`\`\`\n${output}\n\`\`\`\nDiagnose the root cause and give the exact fix.`, files));
      return 0;
    }
    default: {
      const tool = host?.aiTools.find((t) => t.name === sub);
      if (tool) { console.log(await tool.run(params.join(" "))); return 0; }
      throw new AadiError(`Unknown ai subcommand "${sub}"`, "Run `aadi ai help`.");
    }
  }
}

export function extractCode(s: string): string {
  const m = /```[\w-]*\n([\s\S]*?)```/.exec(s);
  return (m ? m[1]! : s).trimEnd() + "\n";
}

async function writeWithApproval(cfg: AadiConfig, rel: string, content: string, yes: boolean): Promise<number> {
  if (!cfg.ai.allowWrite) throw new AadiError("AI file writes are disabled (ai.allowWrite = false)");
  const full = join(cfg.root, rel);
  if (!full.startsWith(cfg.root)) throw new AadiError("Refusing to write outside the project root");
  const exists = existsSync(full);
  console.log(c.dim(`─── ${rel} ${exists ? c.yellow("(overwrite)") : c.green("(new)")} ───`));
  console.log(content.split("\n").slice(0, 60).join("\n") + (content.split("\n").length > 60 ? c.dim("\n…") : ""));
  if (!yes) {
    if (!process.stdin.isTTY) throw new AadiError("Approval required to write files", "Re-run interactively or pass --yes.");
    const answer = prompt(`${exists ? "Overwrite" : "Write"} ${rel}? [y/N]`);
    if (!/^y(es)?$/i.test(answer ?? "")) { log.warn("Skipped"); return 1; }
  }
  if (exists) writeFileSync(full + ".bak", readFileSync(full));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  log.success(`Wrote ${rel}${exists ? ` (backup: ${rel}.bak)` : ""}`);
  return 0;
}
