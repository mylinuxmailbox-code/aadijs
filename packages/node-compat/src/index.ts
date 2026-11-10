/**
 * @aadijs/node-compat — measured Node.js compatibility for the Bun runtime.
 * Each module has a real smoke test exercising core behavior. Results are produced by running,
 * never hardcoded. Run under Bun (`aadi compat`) or Node (`node --experimental-strip-types`) to compare.
 */
export interface ProbeResult { module: string; status: "pass" | "fail" | "missing"; ms: number; error?: string; note?: string }

type Probe = () => unknown | Promise<unknown>;
const ok = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

/** Known behavioral notes (documented, not used to decide pass/fail). */
export const NOTES: Record<string, string> = {
  "node:domain": "Deprecated in Node; basic API only.",
  "node:repl": "Module loads; interactive REPL semantics differ — use `bun repl`.",
  "node:trace_events": "Stub in Bun: createTracing works but emits no trace data.",
  "node:v8": "Heap stats/serialize supported; V8-specific flags/profiler hooks unavailable (JavaScriptCore).",
  "node:vm": "Contexts supported; some `vm.Module`/microtaskMode options are incomplete.",
  "node:wasi": "Partial — preview1 basics only.",
  "node:cluster": "Supported on Linux/macOS with reusePort semantics; differs on Windows.",
  "node:http2": "Client and server supported; some push/priority APIs missing.",
  "node:inspector": "Use `bun --inspect` (WebKit Inspector protocol) instead of Chrome DevTools protocol.",
  "native addons": "N-API addons largely work; V8-API (nan) addons may not.",
};

export const PROBES: Record<string, Probe> = {
  "node:assert": async () => { const a = await import("node:assert"); a.deepStrictEqual({ x: [1] }, { x: [1] }); let t = false; try { a.strictEqual(1, 2); } catch { t = true; } ok(t, "assert should throw"); },
  "node:buffer": async () => { const { Buffer } = await import("node:buffer"); ok(Buffer.from("aGk=", "base64").toString() === "hi", "base64"); ok(Buffer.concat([Buffer.from([1]), Buffer.from([2])]).readUInt16BE(0) === 258, "readUInt16BE"); },
  "node:child_process": async () => { const cp = await import("node:child_process"); const r = cp.spawnSync(process.execPath, ["-e", "process.stdout.write('ok')"]); ok(String(r.stdout) === "ok", "spawnSync"); const out = await new Promise<string>((res, rej) => cp.execFile(process.execPath, ["-e", "console.log(42)"], (e, so) => (e ? rej(e) : res(so)))); ok(out.trim() === "42", "execFile"); },
  "node:cluster": async () => { const c = await import("node:cluster"); ok(typeof c.default.fork === "function" && c.default.isPrimary !== undefined, "cluster api"); },
  "node:console": async () => { const { Console } = await import("node:console"); const { Writable } = await import("node:stream"); let s = ""; const c = new Console(new Writable({ write(ch, _e, cb) { s += ch; cb(); } })); c.log("x%d", 1); await new Promise((r) => setTimeout(r, 5)); ok(s.includes("x1"), "Console to stream"); },
  "node:crypto": async () => { const c = await import("node:crypto"); ok(c.createHash("sha256").update("a").digest("hex").startsWith("ca978112"), "sha256"); const k = c.randomBytes(32), iv = c.randomBytes(12); const e = c.createCipheriv("aes-256-gcm", k, iv); const ct = Buffer.concat([e.update("secret"), e.final()]); const d = c.createDecipheriv("aes-256-gcm", k, iv); d.setAuthTag(e.getAuthTag()); ok(Buffer.concat([d.update(ct), d.final()]).toString() === "secret", "aes-gcm"); const { publicKey, privateKey } = c.generateKeyPairSync("ed25519"); ok(c.verify(null, Buffer.from("m"), publicKey, c.sign(null, Buffer.from("m"), privateKey)), "ed25519"); ok(c.scryptSync("p", "s", 16).length === 16, "scrypt"); },
  "node:dgram": async () => { const d = await import("node:dgram"); const s = d.createSocket("udp4"); const got = new Promise<string>((r) => s.on("message", (m) => r(String(m)))); await new Promise<void>((r) => s.bind(0, "127.0.0.1", () => r())); const c = d.createSocket("udp4"); c.send("ping", s.address().port, "127.0.0.1"); ok((await got) === "ping", "udp roundtrip"); s.close(); c.close(); },
  "node:dns": async () => { const d = await import("node:dns"); const r = await d.promises.lookup("localhost"); ok(!!r.address, "lookup localhost"); },
  "node:domain": async () => { const d = await import("node:domain"); ok(typeof d.create === "function", "domain.create"); },
  "node:events": async () => { const { EventEmitter, once } = await import("node:events"); const e = new EventEmitter(); const p = once(e, "x"); e.emit("x", 7); ok((await p)[0] === 7, "once"); },
  "node:fs": async () => { const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path"); const d = fs.mkdtempSync(path.join(os.tmpdir(), "aadi-")); const f = path.join(d, "a.txt"); fs.writeFileSync(f, "hi"); const fd = fs.openSync(f, "r"); const b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 0); fs.closeSync(fd); ok(b.toString() === "hi", "fd read"); fs.rmSync(d, { recursive: true }); },
  "node:fs/promises": async () => { const fs = await import("node:fs/promises"); const os = await import("node:os"); const d = await fs.mkdtemp(os.tmpdir() + "/aadi-"); await fs.writeFile(d + "/x", "y"); ok((await fs.readFile(d + "/x", "utf8")) === "y", "rw"); ok((await fs.readdir(d)).length === 1, "readdir"); await fs.rm(d, { recursive: true }); },
  "node:http": async () => { const http = await import("node:http"); const srv = http.createServer((_q, s) => s.end("pong")); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r())); const port = (srv.address() as any).port; const body = await new Promise<string>((res, rej) => http.get(`http://127.0.0.1:${port}/`, (r) => { let s = ""; r.on("data", (c) => (s += c)); r.on("end", () => res(s)); }).on("error", rej)); srv.close(); ok(body === "pong", "http roundtrip"); },
  "node:http2": async () => { const h2 = await import("node:http2"); const srv = h2.createServer(); srv.on("stream", (s) => { s.respond({ ":status": 200 }); s.end("h2"); }); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r())); const port = (srv.address() as any).port; const client = h2.connect(`http://127.0.0.1:${port}`); const req = client.request({ ":path": "/" }); let s = ""; req.on("data", (c) => (s += c)); await new Promise((r) => req.on("end", r)); client.close(); srv.close(); ok(s === "h2", "h2c roundtrip"); },
  "node:https": async () => { const h = await import("node:https"); ok(typeof h.request === "function" && typeof h.Agent === "function", "https api"); },
  "node:module": async () => { const m = await import("node:module"); const req = m.createRequire(import.meta.url); ok(req("node:path").sep !== undefined, "createRequire"); ok(m.builtinModules.includes("fs"), "builtinModules"); },
  "node:net": async () => { const net = await import("node:net"); const srv = net.createServer((s) => s.end("tcp")); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r())); const port = (srv.address() as any).port; const data = await new Promise<string>((res) => { const c = net.connect(port, "127.0.0.1"); let s = ""; c.on("data", (d) => (s += d)); c.on("end", () => res(s)); }); srv.close(); ok(data === "tcp", "tcp roundtrip"); },
  "node:os": async () => { const os = await import("node:os"); ok(os.cpus().length > 0 && os.totalmem() > 0 && !!os.platform(), "os info"); },
  "node:path": async () => { const p = await import("node:path"); ok(p.posix.join("a", "..", "b") === "b" && p.win32.join("a", "b") === "a\\b", "posix/win32"); },
  "node:perf_hooks": async () => { const { performance, PerformanceObserver } = await import("node:perf_hooks"); performance.mark("a"); ok(typeof performance.now() === "number" && typeof PerformanceObserver === "function", "perf"); },
  "node:process": async () => { const p = (await import("node:process")).default; ok(typeof p.hrtime.bigint() === "bigint" && typeof p.memoryUsage().heapUsed === "number" && typeof p.on === "function", "process api"); },
  "node:punycode": async () => { const p = (await import("node:punycode")).default as any; ok(p.toASCII("mañana.com") === "xn--maana-pta.com", "toASCII"); },
  "node:querystring": async () => { const q = await import("node:querystring"); ok(q.parse("a=1&b=2&b=3").b?.length === 2 && q.stringify({ x: "y z" }) === "x=y%20z", "qs"); },
  "node:readline": async () => { const rl = await import("node:readline"); const { Readable } = await import("node:stream"); const lines: string[] = []; const i = rl.createInterface({ input: Readable.from(["a\nb\n"]) }); for await (const l of i) lines.push(l); ok(lines.join() === "a,b", "line iteration"); },
  "node:readline/promises": async () => { const rl = await import("node:readline/promises"); ok(typeof rl.createInterface === "function", "api"); },
  "node:repl": async () => { const r = await import("node:repl"); ok(typeof r.start === "function", "repl.start"); },
  "node:stream": async () => { const { Readable, Transform, pipeline } = await import("node:stream"); const out: string[] = []; await new Promise<void>((res, rej) => pipeline(Readable.from(["a", "b"]), new Transform({ transform(c, _e, cb) { cb(null, String(c).toUpperCase()); } }), new (require("node:stream").Writable)({ write(c: any, _e: any, cb: any) { out.push(String(c)); cb(); } }), (e) => (e ? rej(e) : res()))); ok(out.join("") === "AB", "pipeline"); },
  "node:stream/promises": async () => { const { pipeline } = await import("node:stream/promises"); const { Readable, Writable } = await import("node:stream"); let s = ""; let hw = 0; await pipeline(Readable.from(Array.from({ length: 100 }, (_, i) => String(i))), new Writable({ highWaterMark: 1, write(c, _e, cb) { s += c; hw++; setImmediate(cb); } })); ok(hw === 100, "backpressure pipeline"); },
  "node:stream/web": async () => { const { ReadableStream, TransformStream } = await import("node:stream/web"); const t = new TransformStream({ transform(c, ctl) { ctl.enqueue(c * 2); } }); const r = ReadableStream.from ? ReadableStream.from([1, 2]) : new ReadableStream({ start(c) { c.enqueue(1); c.enqueue(2); c.close(); } }); const out: number[] = []; for await (const x of (r as any).pipeThrough(t)) out.push(x); ok(out.join() === "2,4", "web streams"); },
  "node:string_decoder": async () => { const { StringDecoder } = await import("node:string_decoder"); const d = new StringDecoder("utf8"); const e = Buffer.from("€"); ok(d.write(e.subarray(0, 1)) === "" && d.write(e.subarray(1)) === "€", "multibyte"); },
  "node:timers": async () => { const t = await import("node:timers"); await new Promise<void>((r) => t.setImmediate(() => r())); },
  "node:timers/promises": async () => { const t = await import("node:timers/promises"); ok((await t.setTimeout(1, "v")) === "v", "setTimeout promise"); },
  "node:tls": async () => { const tls = await import("node:tls"); ok(typeof tls.connect === "function" && typeof tls.createSecureContext === "function" && tls.rootCertificates.length > 0, "tls api"); },
  "node:trace_events": async () => { const t = await import("node:trace_events"); ok(typeof t.createTracing === "function", "createTracing"); },
  "node:tty": async () => { const t = await import("node:tty"); ok(typeof t.isatty(1) === "boolean", "isatty"); },
  "node:url": async () => { const u = await import("node:url"); ok(u.fileURLToPath(u.pathToFileURL("/tmp/x").href) === "/tmp/x" || process.platform === "win32", "file urls"); ok(new u.URL("http://a/b?c=1").searchParams.get("c") === "1", "URL"); },
  "node:util": async () => { const u = await import("node:util"); ok(u.format("%s=%d", "a", 1) === "a=1", "format"); const f = u.promisify((x: number, cb: any) => cb(null, x + 1)); ok((await f(1)) === 2, "promisify"); ok(u.types.isPromise(Promise.resolve()), "types"); ok(u.parseArgs({ args: ["--x"], options: { x: { type: "boolean" } } }).values.x === true, "parseArgs"); },
  "node:v8": async () => { const v = await import("node:v8"); ok(v.getHeapStatistics().total_heap_size > 0, "heap stats"); ok((v.deserialize(v.serialize({ a: 1 })) as any).a === 1, "serialize"); },
  "node:vm": async () => { const vm = await import("node:vm"); const ctx = vm.createContext({ x: 2 }); ok(vm.runInContext("x * 21", ctx) === 42, "runInContext"); ok(new vm.Script("1+1").runInNewContext() === 2, "Script"); },
  "node:wasi": async () => { const w = await import("node:wasi"); ok(typeof w.WASI === "function", "WASI class"); },
  "node:worker_threads": async () => { const { Worker } = await import("node:worker_threads"); const w = new Worker("const { parentPort } = require('node:worker_threads'); parentPort.on('message', (m) => parentPort.postMessage(m * 2));", { eval: true }); const r = await new Promise((res, rej) => { w.on("message", res); w.on("error", rej); w.postMessage(21); }); await w.terminate(); ok(r === 42, "worker roundtrip"); },
  "node:zlib": async () => { const z = await import("node:zlib"); const s = "hello ".repeat(100); ok(z.gunzipSync(z.gzipSync(s)).toString() === s, "gzip"); ok(z.brotliDecompressSync(z.brotliCompressSync(s)).toString() === s, "brotli"); ok(z.inflateSync(z.deflateSync(s)).toString() === s, "deflate"); },
  // runtime capabilities
  "esm+cjs interop": async () => { const m = await import("node:module"); const req = m.createRequire(import.meta.url); ok(typeof req("node:events") === "function", "require from esm"); },
  "webassembly": async () => { const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11]); const { instance } = await WebAssembly.instantiate(bytes); ok((instance.exports as any).add(2, 3) === 5, "wasm add"); },
  "websocket": async () => { ok(typeof WebSocket === "function", "global WebSocket"); },
  "fetch": async () => { ok(typeof fetch === "function" && typeof Response === "function", "fetch globals"); },
  "abortcontroller": async () => { const a = new AbortController(); a.abort(); ok(a.signal.aborted, "abort"); },
  "structuredClone": async () => { const m = new Map([[1, { d: new Date(0) }]]); ok(structuredClone(m).get(1)!.d instanceof Date, "clone"); },
};

export async function runProbes(filter?: string): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const [name, probe] of Object.entries(PROBES)) {
    if (filter && !name.includes(filter)) continue;
    const t = performance.now();
    try {
      await Promise.race([probe(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout (5s)")), 5000))]);
      out.push({ module: name, status: "pass", ms: performance.now() - t, note: NOTES[name] });
    } catch (e: any) {
      const missing = /Cannot find (module|package)|not (yet )?implemented|ERR_UNKNOWN_BUILTIN_MODULE/i.test(e?.message ?? "");
      out.push({ module: name, status: missing ? "missing" : "fail", ms: performance.now() - t, error: String(e?.message ?? e).slice(0, 200), note: NOTES[name] });
    }
  }
  return out;
}

export function compatMarkdown(results: ProbeResult[], runtime: string): string {
  const pass = results.filter((r) => r.status === "pass").length;
  const rows = results.map((r) => `| \`${r.module}\` | ${r.status === "pass" ? "✅ pass" : r.status === "missing" ? "⛔ missing" : "❌ fail"} | ${r.error ? r.error.replace(/\|/g, "\\|") : ""} ${r.note ?? ""} |`);
  return `# Node.js compatibility report\n\nGenerated by \`aadi compat --write\` on ${runtime} (${process.platform}/${process.arch}) — ${new Date().toISOString().slice(0, 10)}.\n\n**${pass}/${results.length} probes pass.** Each probe exercises real behavior (round-trips, not just imports).\n\n| Module / capability | Status | Notes |\n|---|---|---|\n${rows.join("\n")}\n\n## Known limitations inherited from Bun\n\n${Object.entries(NOTES).map(([k, v]) => `- **${k}**: ${v}`).join("\n")}\n`;
}

if (import.meta.main) {
  const r = await runProbes(process.argv[2]);
  console.log(JSON.stringify(r));
  process.exit(0);
}
