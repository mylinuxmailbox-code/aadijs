/**
 * @aadijs/runtime — High-speed HTTP router, middleware, and server runtime powered by Bun.
 * Includes secure defaults, CORS, JSON/text/HTML helpers, params, and query parsing.
 */
import { SECURITY_HEADERS } from "../../cli/src/static.ts";

export interface AadiContext {
  req: Request;
  url: URL;
  params: Record<string, string>;
  query: Record<string, string>;
  state: Record<string, unknown>;
  json(data: unknown, status?: number, headers?: Record<string, string>): Response;
  text(body: string, status?: number, headers?: Record<string, string>): Response;
  html(body: string, status?: number, headers?: Record<string, string>): Response;
}

export type Handler = (ctx: AadiContext) => Response | Promise<Response>;
export type Middleware = (ctx: AadiContext, next: () => Promise<Response>) => Response | Promise<Response>;

interface RouteEntry {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function compilePath(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const regexStr =
    "^" +
    path
      .replace(/\/+$/, "")
      .replace(/:([A-Za-z0-9_]+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      })
      .replace(/\*/g, "(.*)") +
    "/?$";
  return { pattern: new RegExp(regexStr || "^/?$"), keys };
}

export class AadiApp {
  private routes: RouteEntry[] = [];
  private middlewares: Middleware[] = [];
  private staticRoutes = new Map<string, Handler>();

  use(mw: Middleware): this {
    this.middlewares.push(mw);
    return this;
  }

  on(method: string, path: string, handler: Handler): this {
    const m = method.toUpperCase();
    if (!path.includes(":") && !path.includes("*")) {
      const norm = path === "/" ? "/" : path.replace(/\/+$/, "");
      this.staticRoutes.set(`${m}:${norm}`, handler);
    } else {
      const { pattern, keys } = compilePath(path);
      this.routes.push({ method: m, pattern, keys, handler });
    }
    return this;
  }

  get(path: string, handler: Handler): this { return this.on("GET", path, handler); }
  post(path: string, handler: Handler): this { return this.on("POST", path, handler); }
  put(path: string, handler: Handler): this { return this.on("PUT", path, handler); }
  delete(path: string, handler: Handler): this { return this.on("DELETE", path, handler); }
  patch(path: string, handler: Handler): this { return this.on("PATCH", path, handler); }

  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
    const method = req.method.toUpperCase();

    let matchedHandler: Handler | undefined = this.staticRoutes.get(`${method}:${pathname}`);
    const params: Record<string, string> = {};

    if (!matchedHandler) {
      for (const r of this.routes) {
        if (r.method !== method && r.method !== "ALL") continue;
        const m = r.pattern.exec(pathname);
        if (m) {
          r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? "")));
          matchedHandler = r.handler;
          break;
        }
      }
    }

    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));

    const ctx: AadiContext = {
      req,
      url,
      params,
      query,
      state: {},
      json: (data, status = 200, headers = {}) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", ...headers },
        }),
      text: (body, status = 200, headers = {}) =>
        new Response(body, {
          status,
          headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8", ...headers },
        }),
      html: (body, status = 200, headers = {}) =>
        new Response(body, {
          status,
          headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", ...headers },
        }),
    };

    const finalHandler: Handler = matchedHandler ?? ((c) => c.json({ error: "Not Found", path: pathname }, 404));

    let idx = -1;
    const dispatch = async (i: number): Promise<Response> => {
      if (i <= idx) throw new Error("next() called multiple times");
      idx = i;
      const mw = this.middlewares[i];
      if (mw) return await mw(ctx, () => dispatch(i + 1));
      return await finalHandler(ctx);
    };

    try {
      return await dispatch(0);
    } catch (err: any) {
      return ctx.json({ error: err?.message ?? "Internal Server Error" }, 500);
    }
  };

  listen(port = Number(process.env.PORT ?? 3000), hostname = "0.0.0.0") {
    return Bun.serve({ port, hostname, fetch: this.fetch });
  }
}

export const createApp = () => new AadiApp();

export function cors(origin = "*"): Middleware {
  const corsHeaders = {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
  };
  return async (ctx, next) => {
    if (ctx.req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    const res = await next();
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  };
}
