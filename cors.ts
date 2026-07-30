/** Allowed origins come from configuration; "*" is not an origin policy. */
const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "http://localhost:5173")
  .split(",").map((s) => s.trim()).filter(Boolean);

export function corsHeaders(origin: string | null) {
  const ok = origin && allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin! : allowed[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function preflight(req: Request) {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export function json(body: unknown, status: number, req: Request, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": status >= 400 ? "application/problem+json" : "application/json",
      ...corsHeaders(req.headers.get("origin")),
      ...extra,
    },
  });
}

export function problem(status: number, type: string, title: string, detail: string, req: Request, extra = {}) {
  return json({ type: `https://api.safaritiketi.co.tz/problems/${type}`, title, status, detail, ...extra }, status, req);
}
