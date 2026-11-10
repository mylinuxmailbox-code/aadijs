/**
 * Content-addressable store + tar(.gz) reader/writer.
 * Packages are extracted once into ~/.strato/store/v1/<sha512-hex> and then cloned/hardlinked
 * into node_modules. Integrity (SRI) is verified before anything touches disk.
 */
import { createHash } from "node:crypto";
import {
  chmodSync, constants, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync,
  rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { STRATO_HOME } from "./registry.ts";

export const STORE_DIR = join(STRATO_HOME, "store", "v1");

/** Verify SRI integrity ("sha512-<b64>" / "sha1-<b64>") or legacy hex shasum. Returns canonical sha512 integrity. */
export function verifyIntegrity(data: Uint8Array, integrity?: string, shasum?: string): string {
  const sha512 = "sha512-" + createHash("sha512").update(data).digest("base64");
  if (integrity) {
    const ok = integrity.split(/\s+/).some((entry) => {
      const [algo, ...rest] = entry.split("-");
      const expected = rest.join("-");
      if (!algo || !["sha512", "sha384", "sha256", "sha1"].includes(algo)) return false;
      return createHash(algo).update(data).digest("base64") === expected;
    });
    if (!ok) throw new Error(`Integrity check failed (expected ${integrity.slice(0, 30)}…)`);
  } else if (shasum) {
    if (createHash("sha1").update(data).digest("hex") !== shasum) throw new Error("Integrity check failed (sha1 shasum mismatch)");
  }
  return sha512;
}

export function storeKey(integrity: string) {
  const [algo, b64] = [integrity.slice(0, integrity.indexOf("-")), integrity.slice(integrity.indexOf("-") + 1)];
  return `${algo}-${Buffer.from(b64, "base64").toString("hex")}`;
}
export const storePath = (integrity: string) => join(STORE_DIR, storeKey(integrity));

export function hasInStore(integrity?: string) {
  if (!integrity) return false;
  const p = storePath(integrity.split(/\s+/)[0]!);
  return existsSync(join(p, ".strato-ok"));
}

/** Extract a .tgz buffer into the store (atomic rename). Strips the first path component like npm. */
export function addToStore(tgz: Uint8Array, integrity: string): string {
  const dest = storePath(integrity.split(/\s+/)[0]!);
  if (existsSync(join(dest, ".strato-ok"))) return dest;
  const tmp = dest + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2);
  extractTgz(tgz, tmp);
  writeFileSync(join(tmp, ".strato-ok"), "");
  try { renameSync(tmp, dest); } catch {
    rmSync(tmp, { recursive: true, force: true }); // lost a race; another process stored it
    if (!existsSync(join(dest, ".strato-ok"))) throw new Error(`Failed to write store entry ${dest}`);
  }
  return dest;
}

export function touchStore(dir: string) {
  const now = new Date();
  try { utimesSync(join(dir, ".strato-ok"), now, now); } catch {}
}

export function extractTgz(tgz: Uint8Array, dest: string) {
  const tar = tgz[0] === 0x1f && tgz[1] === 0x8b ? Bun.gunzipSync(tgz) : tgz;
  const root = normalize(dest);
  mkdirSync(root, { recursive: true });
  let off = 0, longName: string | undefined, paxPath: string | undefined;
  const dec = new TextDecoder();
  const str = (o: number, l: number) => { const s = tar.subarray(o, o + l); const z = s.indexOf(0); return dec.decode(z >= 0 ? s.subarray(0, z) : s); };
  while (off + 512 <= tar.length) {
    if (tar[off] === 0 && tar.subarray(off, off + 512).every((b) => b === 0)) break;
    let name = str(off, 100);
    const mode = parseInt(str(off + 100, 8).trim() || "644", 8);
    const sizeField = tar.subarray(off + 124, off + 136);
    const size = sizeField[0]! & 0x80 ? Number(Buffer.from(sizeField.subarray(1)).readBigUInt64BE(3)) : parseInt(str(off + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(tar[off + 156] || 48);
    const magic = str(off + 257, 6);
    if (magic.startsWith("ustar")) { const prefix = str(off + 345, 155); if (prefix) name = prefix + "/" + name; }
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = dec.decode(body).replace(/\0.*$/s, ""); continue; }
    if (type === "x") { const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(body)); if (m) paxPath = m[1]; continue; }
    if (type === "g") continue;
    if (longName) { name = longName; longName = undefined; }
    if (paxPath) { name = paxPath; paxPath = undefined; }
    const rel = name.replace(/\\/g, "/").split("/").slice(1).join("/");
    if (!rel) continue;
    const target = normalize(join(root, rel));
    if (!target.startsWith(root + sep)) throw new Error(`Refusing to extract path outside package: ${name}`); // zip-slip guard
    if (type === "5") { mkdirSync(target, { recursive: true }); continue; }
    if (type !== "0" && type !== "\0" && type !== "7") continue; // skip symlinks/hardlinks/devices for safety
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    if (mode & 0o111) chmodSync(target, 0o755);
  }
}

/** Create a gzipped tarball (npm pack layout: package/<file>). */
export function createTgz(files: { path: string; data: Uint8Array; mode?: number }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const f of files) {
    const h = new Uint8Array(512);
    const full = "package/" + f.path.replace(/\\/g, "/");
    let name = full, prefix = "";
    if (enc.encode(full).length > 100) { const i = full.lastIndexOf("/", 154); prefix = full.slice(0, i); name = full.slice(i + 1); }
    const put = (s: string, o: number, l: number) => h.set(enc.encode(s).subarray(0, l), o);
    put(name, 0, 100);
    put(((f.mode ?? 0o644) & 0o7777).toString(8).padStart(7, "0") + "\0", 100, 8);
    put("0000000\0", 108, 8); put("0000000\0", 116, 8);
    put(f.data.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    put("14751305000\0", 136, 12); // fixed mtime (1985) → reproducible tarballs
    put("        ", 148, 8);
    h[156] = 48;
    put("ustar\0", 257, 6); put("00", 263, 2); put(prefix, 345, 155);
    let sum = 0; for (const b of h) sum += b;
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(h, f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024));
  return Bun.gzipSync(Buffer.concat(chunks));
}

export type LinkMode = "clone" | "hardlink" | "copy";
export const defaultLinkMode = (): LinkMode =>
  (process.env.STRATO_LINK_MODE as LinkMode) ?? (process.platform === "darwin" ? "clone" : process.platform === "win32" ? "copy" : "hardlink");

/** Materialize a store directory into a node_modules location. */
export function linkTree(src: string, dest: string, mode: LinkMode) {
  mkdirSync(dest, { recursive: true });
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    if (ent.name === ".strato-ok" || ent.name === ".git") continue;
    const s = join(src, ent.name), d = join(dest, ent.name);
    if (ent.isDirectory()) { linkTree(s, d, mode); continue; }
    if (!ent.isFile()) continue;
    if (existsSync(d)) rmSync(d, { force: true });
    if (mode === "hardlink") { try { linkSync(s, d); continue; } catch { /* cross-device: fall back */ } }
    copyFileSync(s, d, mode === "clone" ? constants.COPYFILE_FICLONE : 0);
  }
}

/** Remove store entries not used for `days` (usage is tracked via mtime of the marker). */
export function pruneStore(days: number): { removed: number } {
  if (!existsSync(STORE_DIR)) return { removed: 0 };
  const cutoff = Date.now() - days * 86400_000;
  let removed = 0;
  for (const e of readdirSync(STORE_DIR)) {
    const p = join(STORE_DIR, e);
    try {
      const m = join(p, ".strato-ok");
      if (!existsSync(m) || statSync(m).mtimeMs < cutoff) { rmSync(p, { recursive: true, force: true }); removed++; }
    } catch {}
  }
  return { removed };
}
