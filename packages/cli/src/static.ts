/** Production static server for web builds: precompressed-aware, immutable caching for hashed assets, secure headers. */
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { c, log } from "../../utils/src/index.ts";

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin",
};

export function staticHandler(root: string) {
  const base = normalize(root);
  return async (req: Request): Promise<Response> => {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: SECURITY_HEADERS });
    const url = new URL(req.url);
    let p = normalize(join(base, decodeURIComponent(url.pathname)));
    if (!p.startsWith(base)) return new Response("Forbidden", { status: 403, headers: SECURITY_HEADERS });
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
    if (!existsSync(p)) p = join(base, "index.html"); // SPA fallback
    const hashed = /-[a-z0-9]{8,}\.\w+$/.test(p);
    return new Response(Bun.file(p), {
      headers: { ...SECURITY_HEADERS, "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache" },
    });
  };
}

export async function serveStatic(root: string, port: number) {
  const server = Bun.serve({ port, fetch: staticHandler(root) });
  log.info(`${c.bold(c.cyan("⚡ AadiJS"))} serving ${root} at ${c.cyan(`http://localhost:${server.port}/`)}`);
  return server;
}
