/**
 * Aadi AI — provider architecture. Pure fetch, zero SDK dependencies.
 * Providers: OpenAI (and any OpenAI-compatible endpoint), Anthropic, Google Gemini, Ollama (local).
 */
export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ChatOptions { model?: string; maxTokens?: number; temperature?: number; signal?: AbortSignal }
export interface Provider {
  name: string;
  defaultModel: string;
  chat(messages: ChatMessage[], o?: ChatOptions): Promise<string>;
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  const text = await res.text();
  if (!res.ok) throw new Error(`AI provider error HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

export function openai(apiKey = process.env.OPENAI_API_KEY, baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"): Provider {
  return {
    name: "openai", defaultModel: process.env.AADI_AI_MODEL ?? "gpt-4o-mini",
    async chat(messages, o = {}) {
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
      const j = await post(`${baseUrl}/chat/completions`, { authorization: `Bearer ${apiKey}` }, { model: o.model ?? this.defaultModel, messages, max_tokens: o.maxTokens ?? 4096, temperature: o.temperature ?? 0.2 }, o.signal);
      return j.choices?.[0]?.message?.content ?? "";
    },
  };
}

export function anthropic(apiKey = process.env.ANTHROPIC_API_KEY): Provider {
  return {
    name: "anthropic", defaultModel: process.env.AADI_AI_MODEL ?? "claude-sonnet-4-5",
    async chat(messages, o = {}) {
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const j = await post("https://api.anthropic.com/v1/messages", { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, {
        model: o.model ?? this.defaultModel, max_tokens: o.maxTokens ?? 4096, temperature: o.temperature ?? 0.2, system,
        messages: messages.filter((m) => m.role !== "system"),
      }, o.signal);
      return (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    },
  };
}

export function google(apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY): Provider {
  return {
    name: "google", defaultModel: process.env.AADI_AI_MODEL ?? "gemini-2.5-flash",
    async chat(messages, o = {}) {
      if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${o.model ?? this.defaultModel}:generateContent`, { "x-goog-api-key": apiKey }, {
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { temperature: o.temperature ?? 0.2, maxOutputTokens: o.maxTokens ?? 4096 },
      }, o.signal);
      return j.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
    },
  };
}

export function ollama(host = process.env.OLLAMA_HOST ?? "http://localhost:11434"): Provider {
  return {
    name: "ollama", defaultModel: process.env.AADI_AI_MODEL ?? "llama3.2",
    async chat(messages, o = {}) {
      const j = await post(`${host}/api/chat`, {}, { model: o.model ?? this.defaultModel, messages, stream: false, options: { temperature: o.temperature ?? 0.2 } }, o.signal);
      return j.message?.content ?? "";
    },
  };
}

const registry: Record<string, () => Provider> = { openai, anthropic, google, ollama };

/** Register a custom provider (e.g. from a plugin). */
export function registerProvider(name: string, factory: () => Provider) { registry[name] = factory; }

/** Pick a provider: explicit > config > first one with credentials. Returns undefined if none configured. */
export function pickProvider(name?: string): Provider | undefined {
  if (name) { const f = registry[name]; if (!f) throw new Error(`Unknown AI provider "${name}". Available: ${Object.keys(registry).join(", ")}`); return f(); }
  if (process.env.AADI_AI_PROVIDER) return pickProvider(process.env.AADI_AI_PROVIDER);
  if (process.env.ANTHROPIC_API_KEY) return anthropic();
  if (process.env.OPENAI_API_KEY) return openai();
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return google();
  return undefined;
}
