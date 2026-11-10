# AadiJS & Strato Security Architecture

Speed in AadiJS never comes at the cost of insecure defaults:

1. **Cryptographic Tarball Integrity (SRI)**: Every package downloaded by Strato is verified against its `sha512` (or `sha1`) registry digest in [`verifyIntegrity()`](../packages/strato/src/store.ts) *before* extraction. Tampered archives abort immediately.
2. **Zip-Slip & Path Traversal Prevention**: Tar extraction normalizes all entry paths and rejects any archive entry attempting to escape the package root (`../`) or create device/symlink nodes. Bin links similarly validate names and target paths.
3. **Lifecycle Script Isolation**: Untrusted dependency `preinstall`/`install`/`postinstall` scripts do not execute unless explicitly allow-listed in `"trustedDependencies"` in `package.json` or `--allow-scripts` is passed.
4. **Automated Vulnerability Auditing & Remediation**: `strato audit` queries the npm bulk advisory database against `strato.lock`, and `strato audit --fix` automatically pins safe non-vulnerable versions via `overrides`.
5. **AI Privacy & Human-in-the-Loop Controls**:
   - `aadi ai` is 100% optional and never required to run or build apps.
   - Secret redaction (`packages/ai/src/context.ts`) strips OpenAI, Anthropic, AWS, GitHub, Google, Slack, PEM private keys, and password/token assignments before any prompt leaves the machine, and excludes `.env*`, `*.pem`, and `*.key` files.
   - File writes (`aadi ai gen`, `aadi ai test`) preview diffs, create `.bak` backups, and require explicit TTY confirmation unless `--yes` is passed.
6. **HTTP Server Defaults**: Both `@aadijs/runtime` and the static server emit `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Cross-Origin-Opener-Policy: same-origin` by default.
