# ⚡ AadiJS
### The Next-Generation JavaScript Ecosystem — Powered by Bun. Engineered for Speed. Built for AI.

> *"Why wait when you can Aadi?"*

AadiJS is a unified, zero-bloat JavaScript & TypeScript development ecosystem built around three core pillars:

1. **AadiJS Framework (`aadi`)** — Zero-config CLI, instant HMR dev server, incremental content-hashed bundler, high-speed HTTP runtime, plugin engine, and test runner.
2. **Strato (`strato`)** — Standalone, high-concurrency package manager with a content-addressable store (`~/.strato/store/v1`), copy-on-write/hardlink materialization, deterministic `strato.lock`, workspaces, security audit, and strict lifecycle script isolation.
3. **Aadi AI (`aadi ai`)** — Optional AI-native intelligence layer with offline AST/export scanning, automatic secret redaction, human-in-the-loop write approval, and zero-SDK providers for OpenAI, Anthropic, Google Gemini, and local Ollama.

---

## Quick Start

```bash
# Link `aadi` and `strato` globally
cd ~/aadijs && bun link

# Create a new project, start HMR dev server, or build for production
aadi create my-app --template web
cd my-app
aadi dev
aadi build --analyze
```

## Monorepo Architecture

```text
aadijs/
├── packages/
│   ├── cli/          # Unified `aadi` CLI (lazy command loading, ~10ms cold start)
│   ├── core/         # Config engine (`aadi.config.ts`) & public exports
│   ├── runtime/      # High-speed HTTP router, middleware, CORS, security headers
│   ├── node-compat/  # 48 live Node.js API & runtime capability probes
│   ├── strato/       # Standalone `strato` package manager (CAS, resolver, CLI)
│   ├── bundler/      # Incremental SHA-256 cached build pipeline & analyzer
│   ├── dev-server/   # Native HMR + Fast Refresh web & `--hot` server runner
│   ├── testing/      # Sharded parallel test runner + micro-benchmarking (`bench`)
│   ├── ai/           # Offline AST context scanner, secret redactor & LLM providers
│   ├── plugins/      # DAG-ordered plugin host (`definePlugin`, lifecycle hooks)
│   └── utils/        # Zero-dep logger, argv parser, concurrency limiter, Levenshtein
├── templates/        # `web`, `server`, and `lib` starter templates
├── benchmarks/       # Reproducible benchmark suite (`bun run bench`)
├── tests/            # Ecosystem unit & integration test suite (`bun test`)
└── docs/             # Generated `COMPAT.md` and `BENCHMARKS.md`
```

## Key Commands

| Command | Description |
|---|---|
| `aadi create <dir> [--template web\|server\|lib]` | Scaffold a project and install dependencies via Strato |
| `aadi dev [--port 3000]` | Start instant HMR dev server (web or `--hot` server mode) |
| `aadi build [--analyze] [--format esm,cjs] [--compile]` | Production build with content-hash caching |
| `aadi test [--parallel] [--coverage] [--watch]` | Run tests (with optional multi-process sharding) |
| `aadi ai context \| ask \| explain \| review \| test \| gen \| fix` | AI-native codebase intelligence (optional; works offline for `context`) |
| `aadi compat [--write] [--node]` | Run 48 live Node.js compatibility probes |
| `strato install \| add \| remove \| update \| upgrade \| audit \| why \| graph` | Standalone Strato package manager commands |
