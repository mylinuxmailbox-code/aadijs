# AadiJS Reproducible Benchmarks

Measured on `darwin/arm64` (Apple M6, 12 cores, 24.0 GB RAM) with **Bun 1.4.4** and **Node v26.13.0**.

Reproduce anytime with:
```bash
bun run bench
```

| Workload | AadiJS / Strato | Baseline | Speedup |
|---|---|---|---|
| CLI startup (`aadi --version`) | **10ms** (min 8ms) | — | Instant |
| HTTP JSON routing (`GET /json`, 50 concurrent) | **105,264 req/s** | `node:http`: 113,493 req/s | **0.93x** |
| Package install (express + zod + chalk, warm cache, clean `node_modules`) | **Strato CAS: 12ms** | `npm install --prefer-offline`: 210ms | **17.3x faster** |
| Incremental install (unchanged lockfile & state) | **Strato: 11ms** | — | Sub-50ms |
