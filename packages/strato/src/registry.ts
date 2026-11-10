/**
 * Registry client: npmrc parsing, scoped/private registries, auth, abbreviated packuments,
 * on-disk metadata cache with ETag revalidation, and offline mode.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { limiter } from "../../utils/src/index.ts";

export const STRATO_HOME = process.env.STRATO_HOME ?? join(homedir(), ".strato");
export const META_DIR = join(STRATO_HOME, "cache", "meta");

export interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, Manifest>;
  time?: Record<string, string>;
}
export interface Manifest {
  name: string; version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  directories?: { bin?: string };
  scripts?: Record<string, string>;
  hasInstallScript?: boolean;
  os?: string[]; cpu?: string[];
  deprecated?: string;
  dist: { tarball: string; integrity?: string; shasum?: string };
}

export interface NpmrcConfig { registry: string; scopes: Record<string, string>; tokens: Record<string, string> }

export function readNpmrc(cwd: string): NpmrcConfig {
  const cfg: NpmrcConfig = { registry: "https://registry.npmjs.org/", scopes: {}, tokens: {} };
  for (const file of [join(homedir(), ".npmrc"), join(cwd, ".npmrc")]) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim().replace(/\$\{([^}]+)\}/g, (_, n) => process.env[n] ?? "");
      if (k === "registry") cfg.registry = v.endsWith("/") ? v : v + "/";
      else if (/^@[^:]+:registry$/.test(k)) cfg.scopes[k.split(":")[0]!] = v.endsWith("/") ? v : v + "/";
      else if (k.endsWith(":_authToken")) cfg.tokens[k.slice(0, -":_authToken".length).replace(/^\/\//, "")] = v;
    }
  }
  if (process.env.STRATO_REGISTRY) cfg.registry = process.env.STRATO_REGISTRY.replace(/\/?$/, "/");
  return cfg;
}

export class Registry {
  private mem = new Map<string, Promise<Packument>>();
  private limit = limiter(Number(process.env.STRATO_NETWORK_CONCURRENCY ?? 64));
  stats = { metaRequests: 0, metaCacheHits: 0, tarballs: 0, tarballBytes: 0 };

  constructor(public cfg: NpmrcConfig, public offline = false, public preferOffline = false) {
    mkdirSync(META_DIR, { recursive: true });
  }

  registryFor(name: string) {
    return name.startsWith("@") ? this.cfg.scopes[name.split("/")[0]!] ?? this.cfg.registry : this.cfg.registry;
  }

  authHeader(url: string): Record<string, string> {
    const u = new URL(url);
    const hostPath = u.host + u.pathname;
    let best = "";
    for (const k of Object.keys(this.cfg.tokens)) if (hostPath.startsWith(k.replace(/\/$/, "")) && k.length > best.length) best = k;
    return best ? { authorization: `Bearer ${this.cfg.tokens[best]}` } : {};
  }

  packument(name: string): Promise<Packument> {
    let p = this.mem.get(name);
    if (!p) { p = this.fetchPackument(name); this.mem.set(name, p); }
    return p;
  }

  private async fetchPackument(name: string): Promise<Packument> {
    const file = join(META_DIR, encodeURIComponent(name) + ".json");
    const f = Bun.file(file);
    let cached: { etag?: string; fetchedAt: number; data: Packument } | undefined;
    if (await f.exists()) {
      try { cached = await f.json(); } catch { cached = undefined; }
    }
    if (cached && (this.offline || (this.preferOffline && Date.now() - cached.fetchedAt < 5 * 60_000))) {
      this.stats.metaCacheHits++;
      return cached.data;
    }
    if (this.offline) throw new Error(`Offline: no cached metadata for "${name}"`);
    const url = this.registryFor(name) + name.replace("/", "%2f");
    const headers: Record<string, string> = {
      accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8",
      ...this.authHeader(url),
    };
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    const res = await this.limit(() => fetchRetry(url, { headers }));
    this.stats.metaRequests++;
    if (res.status === 304 && cached) {
      this.stats.metaCacheHits++;
      cached.fetchedAt = Date.now();
      Bun.write(file, JSON.stringify(cached)).catch(() => {});
      return cached.data;
    }
    if (res.status === 404) throw new Error(`Package "${name}" not found in registry ${this.registryFor(name)}`);
    if (!res.ok) throw new Error(`Registry error ${res.status} for "${name}"`);
    const data = (await res.json()) as Packument;
    Bun.write(file, JSON.stringify({ etag: res.headers.get("etag") ?? undefined, fetchedAt: Date.now(), data })).catch(() => {});
    return data;
  }

  /** Fetch full (non-abbreviated) packument, used by `info`. */
  async fullPackument(name: string): Promise<any> {
    const url = this.registryFor(name) + name.replace("/", "%2f");
    const res = await fetchRetry(url, { headers: { accept: "application/json", ...this.authHeader(url) } });
    if (!res.ok) throw new Error(`Registry error ${res.status} for "${name}"`);
    return res.json();
  }

  async tarball(url: string): Promise<Uint8Array> {
    if (this.offline) throw new Error(`Offline: tarball not in store: ${url}`);
    const res = await this.limit(() => fetchRetry(url, { headers: this.authHeader(url) }));
    if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    this.stats.tarballs++;
    this.stats.tarballBytes += buf.byteLength;
    return buf;
  }
}

async function fetchRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init);
      if (r.status >= 500 || r.status === 429) { lastErr = new Error(`HTTP ${r.status}`); await Bun.sleep(200 * 2 ** i); continue; }
      return r;
    } catch (e) { lastErr = e; await Bun.sleep(200 * 2 ** i); }
  }
  throw new Error(`Network request failed for ${url}: ${(lastErr as Error)?.message}`);
}
