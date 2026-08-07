/**
 * Unit tests for the loopback API runtime-acceptance drives a generated connector against.
 *
 * Every one of that harness's twenty checks is an assertion about what landed in `recorded`
 * or about what the connector did with a reply from here. "an unset optional boolean renders
 * false in the URL" reads `recorded[i].path`; "a write sends Content-Type: application/json"
 * reads `recorded[i].contentType`; "the token is cached — two tool calls, one exchange"
 * counts `/oauth/token` entries. So a recorder that dropped a header or lost a query string
 * would not fail those checks — it would answer them wrongly, and the failure would be read
 * as an emitter defect.
 *
 * Driven with real `fetch` against the real server, since that is the only thing that proves
 * the recording survives an actual request rather than a hand-made object.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { type Recorded, startApi } from "../../scripts/_lib/fake-api.ts";

let running: ReturnType<typeof startApi> | undefined;

afterEach(() => {
  running?.server.stop(true);
  running = undefined;
});

function start(): { base: string; recorded: Recorded[]; hostname: string | undefined } {
  const recorded: Recorded[] = [];
  running = startApi(recorded);
  return { base: running.base, recorded, hostname: running.server.hostname };
}

describe("startApi", () => {
  it("listens on an ephemeral loopback port", async () => {
    // Loopback, and never a fixed port: two runs must not collide, and the harness must not
    // be reachable from off the machine while it is echoing synthetic credentials.
    const { base, hostname } = start();

    // The bind address, not just the URL string the harness prints: `base` is built from a
    // literal, so it would keep saying 127.0.0.1 while the socket listened on 0.0.0.0. This
    // server echoes synthetic credentials back into a request log — it has no business being
    // reachable from off the machine.
    expect(hostname).toBe("127.0.0.1");
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(`${base}/items`)).json()).toEqual({ ok: true, path: "/items" });
  });

  it("records the method, the path and the query string together", async () => {
    // `?flag=false` is the entire evidence for the documented decision that an unset optional
    // boolean reaches the URL as false. Recording `pathname` alone would silently discard it
    // and the check would compare "/items" against "/items?flag=false" forever.
    const { base, recorded } = start();

    await fetch(`${base}/items?flag=false&x=1`);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe("GET");
    expect(recorded[0]?.path).toBe("/items?flag=false&x=1");
  });

  it("keeps percent-encoding in the recorded path rather than decoding it", async () => {
    // "path args are percent-encoded at runtime" asserts on exactly these bytes: decoding
    // here would turn /items/a%20b%2Fc into /items/a b/c and the check would fail against a
    // connector that did the right thing.
    const { base, recorded } = start();

    await fetch(`${base}/items/a%20b%2Fc`);

    expect(recorded[0]?.path).toBe("/items/a%20b%2Fc");
  });

  it("records the Authorization and X-Api-Key headers", async () => {
    const { base, recorded } = start();

    await fetch(`${base}/items`, {
      headers: { authorization: "Bearer tok-123", "x-api-key": "key-9" },
    });

    expect(recorded[0]?.auth).toBe("Bearer tok-123");
    expect(recorded[0]?.apiKey).toBe("key-9");
  });

  it("records an absent header as undefined, not as an empty string", async () => {
    // describeAuth distinguishes "absent" from "present, unexpected value" on exactly this.
    // An empty string would report the connector as having sent a wrong credential when it
    // sent none at all — the opposite diagnosis.
    const { base, recorded } = start();

    await fetch(`${base}/items`);

    expect(recorded[0]?.auth).toBeUndefined();
    expect(recorded[0]?.apiKey).toBeUndefined();
  });

  it("records a write's body and content type", async () => {
    const { base, recorded } = start();

    await fetch(`${base}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"title":"hello","draft":true}',
    });

    expect(recorded[0]?.method).toBe("POST");
    expect(recorded[0]?.body).toBe('{"title":"hello","draft":true}');
    expect(recorded[0]?.contentType).toContain("application/json");
  });

  it("records an empty body for GET and DELETE without waiting on a body that never comes", async () => {
    // "a DELETE whose only arg is in the path sends no body" asserts body === "". Reading
    // req.text() on a bodiless request is also what the method guard avoids.
    const { base, recorded } = start();

    await fetch(`${base}/items`);
    await fetch(`${base}/items/x1`, { method: "DELETE" });

    expect(recorded.map((r) => r.body)).toEqual(["", ""]);
  });

  it("keeps requests in arrival order", async () => {
    // Every "the token exchange happens before the API call" style check is an ordering
    // statement, and several scenarios slice the log by index to isolate their own traffic.
    const { base, recorded } = start();

    await fetch(`${base}/first`);
    await fetch(`${base}/second`);
    await fetch(`${base}/third`);

    expect(recorded.map((r) => r.path)).toEqual(["/first", "/second", "/third"]);
  });

  it("mints a long-lived token at /oauth/token", async () => {
    const { base } = start();

    const body = await (await fetch(`${base}/oauth/token`, { method: "POST", body: "" })).json();

    expect(body).toEqual({ access_token: "exchanged-token-abc", expires_in: 3600 });
  });

  it("mints a 2-second token when the token URL carries ?short", async () => {
    // The whole expiry scenario rests on this: the emitted client halves its 60s renewal
    // skew for short-lived tokens, so expires_in 2 is treated as valid for 1 second and a
    // 1.4s gap straddles an expiry. Returning 3600 here would make "an expired token is
    // re-exchanged" pass only if the cache were broken.
    const { base } = start();

    const body = (await (await fetch(`${base}/oauth/token?short`, { method: "POST" })).json()) as {
      expires_in: number;
    };

    expect(body.expires_in).toBe(2);
  });

  it("mints a DIFFERENT short token each time", async () => {
    // "the API call after re-exchange carries the NEW token" compares two Authorization
    // headers. If every exchange returned the same string they would be equal, and that
    // check would fail against a connector that re-exchanged correctly.
    const { base } = start();

    const first = (await (await fetch(`${base}/oauth/token?short`, { method: "POST" })).json()) as {
      access_token: string;
    };
    const second = (await (
      await fetch(`${base}/oauth/token?short`, { method: "POST" })
    ).json()) as {
      access_token: string;
    };

    expect(first.access_token).not.toBe(second.access_token);
    expect(first.access_token.startsWith("short-")).toBe(true);
  });

  it("records the token-exchange form body, which is how credentialsIn is checked", async () => {
    const { base, recorded } = start();

    await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&client_id=id-1&client_secret=secret-1",
    });

    expect(recorded[0]?.body).toContain("client_id=id-1");
  });

  it("answers /boom with a 500 so the emitted error branch runs", async () => {
    // The only route that exercises the generated non-2xx handling end to end. The status
    // has to be the one the check looks for by name.
    const { base } = start();

    const res = await fetch(`${base}/boom`);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("upstream exploded");
  });

  it("records /boom too — an error response is still traffic", async () => {
    const { base, recorded } = start();

    await fetch(`${base}/boom`);

    expect(recorded.map((r) => r.path)).toEqual(["/boom"]);
  });

  it("echoes the path for every other route, so a wrong URL is visible in the reply", async () => {
    const { base } = start();

    expect(await (await fetch(`${base}/items/x1`)).json()).toEqual({
      ok: true,
      path: "/items/x1",
    });
  });
});
