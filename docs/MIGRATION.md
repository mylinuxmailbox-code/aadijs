# Migrating from Node.js / npm to AadiJS & Strato

AadiJS runs on **Bun** and is engineered for drop-in migration from Node.js, npm, pnpm, and Yarn.

## 1. Package Management (`npm` / `pnpm` / `yarn` → `strato`)

| Existing Command | Strato / AadiJS Equivalent |
|---|---|
| `npm install` / `npm ci` | `strato install` / `strato ci` (or `strato install --frozen-lockfile`) |
| `npm install <pkg>` | `strato add <pkg>` (`-D` for dev, `-E` for exact, `-O` for optional) |
| `npm uninstall <pkg>` | `strato remove <pkg>` |
| `npm run <script>` | `strato run <script>` or `aadi run <script>` |
| `npm audit [--fix]` | `strato audit [--fix]` |
| `npm outdated` | `strato outdated` |
| `npm explain <pkg>` | `strato why <pkg>` |
| `npm publish` | `strato publish` |

### Key Differences to Know
- **Content-Addressable Store**: Packages are extracted once into `~/.strato/store/v1` and cloned/hardlinked into `node_modules`.
- **Lifecycle Script Security**: Dependency `preinstall`/`install`/`postinstall` scripts are **blocked by default** unless listed in `"trustedDependencies": ["pkg-name"]` in `package.json` or run with `--allow-scripts`.

## 2. Runtime & Built-in Node Modules
Run `aadi compat` in your project at any time to execute 48 live behavioral probes across `node:*` built-in modules. See [`COMPAT.md`](./COMPAT.md) for the full compatibility matrix and known JavaScriptCore vs. V8 differences.
