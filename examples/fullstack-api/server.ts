/**
 * Example: High-speed AadiJS HTTP API server with middleware, CORS, and route parameters.
 * Run with: `bun examples/fullstack-api/server.ts` or `aadi dev` inside this folder.
 */
import { createApp, cors } from "../../packages/runtime/src/index.ts";

const app = createApp();
app.use(cors());

const items = new Map<string, { id: string; name: string; createdAt: number }>([
  ["1", { id: "1", name: "Strato Package Manager", createdAt: Date.now() }],
  ["2", { id: "2", name: "Aadi AI Layer", createdAt: Date.now() }],
]);

app.get("/health", (c) => c.json({ ok: true, uptime: process.uptime() }));
app.get("/items", (c) => c.json([...items.values()]));
app.get("/items/:id", (c) => {
  const item = items.get(c.params.id!);
  return item ? c.json(item) : c.json({ error: "Item not found" }, 404);
});
app.post("/items", async (c) => {
  const body = (await c.req.json()) as { name?: string };
  if (!body.name) return c.json({ error: "Missing name" }, 400);
  const id = String(items.size + 1);
  const item = { id, name: body.name, createdAt: Date.now() };
  items.set(id, item);
  return c.json(item, 201);
});

export default app;

if (import.meta.main) {
  const srv = app.listen(Number(process.env.PORT ?? 3000));
  console.log(`⚡ Example API listening on http://localhost:${srv.port}`);
}
