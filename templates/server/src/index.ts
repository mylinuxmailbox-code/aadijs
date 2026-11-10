export function handleRequest(req: Request): Response {
  const url = new URL(req.url);
  if (url.pathname === "/health") {
    return Response.json({ ok: true, runtime: "AadiJS/Bun" });
  }
  return Response.json({ message: "Why wait when you can Aadi?", path: url.pathname });
}

if (import.meta.main) {
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 3000),
    fetch: handleRequest,
  });
  console.log(`⚡ AadiJS server listening on http://localhost:${server.port}`);
}
