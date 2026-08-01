/**
 * The loopback HTTP server runtime-acceptance points a generated connector at, and the
 * request log every one of its twenty checks is asserted against.
 *
 * This is not a detail of the harness — it IS the harness's evidence. "an unset optional
 * boolean renders false in the URL", "a path arg is excluded from the default write body",
 * "the token is cached — two tool calls, one exchange" are all statements about what landed
 * in `recorded`, so a recorder that dropped a header, mangled a query string or answered the
 * wrong status would turn twenty real assertions into twenty assertions about a bug in here.
 * None of it had ever been executed by a test, because it sat in a file whose other half
 * runs `bun install` five times.
 */

/** One recorded inbound request, kept in arrival order. */
export type Recorded = {
  method: string;
  path: string;
  auth: string | undefined;
  apiKey: string | undefined;
  contentType: string | undefined;
  body: string;
};

/**
 * Start the fake API on an ephemeral loopback port, appending to `recorded`.
 *
 * Answers by path:
 *   /oauth/token      → 200 with an access token
 *   /boom             → 500, to exercise the emitted error branch
 *   anything else     → 200 `{ ok: true, path }`
 *
 * The caller owns the returned server and must `stop(true)` it.
 */
export function startApi(recorded: Recorded[]): {
  server: ReturnType<typeof Bun.serve>;
  base: string;
} {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
      recorded.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        auth: req.headers.get("authorization") ?? undefined,
        apiKey: req.headers.get("x-api-key") ?? undefined,
        contentType: req.headers.get("content-type") ?? undefined,
        body,
      });
      if (url.pathname === "/oauth/token") {
        // `?short` mints a 2-second token, so the expiry path can be observed rather than
        // reasoned about. The emitted code halves its 60s renewal skew for short-lived
        // tokens, so expires_in: 2 is treated as valid for 1 second. Each short token is
        // distinct (`short-<n>`), which is what lets "the API call after re-exchange carries
        // the NEW token" compare two Authorization headers rather than take it on trust.
        const short = url.search.includes("short");
        return Response.json({
          access_token: short ? `short-${recorded.length}` : "exchanged-token-abc",
          expires_in: short ? 2 : 3600,
        });
      }
      if (url.pathname === "/boom") {
        return new Response("upstream exploded", { status: 500 });
      }
      return Response.json({ ok: true, path: url.pathname });
    },
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}
