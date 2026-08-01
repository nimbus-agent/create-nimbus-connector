import { describe, expect, it } from "bun:test";
import { renderEnvAccessor, renderEnvAccessors } from "../../../src/emit/server/env.ts";
import { EnvSchema, parseSpec } from "../../../src/spec.ts";

const env = (raw: unknown) => EnvSchema.parse(raw);

describe("renderEnvAccessor", () => {
  it("renders a required string accessor", () => {
    const out = renderEnvAccessor(
      env({ vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true }),
    );
    expect(out).toBe(`function apiKey(): string {
  const k = process.env["NEW_RELIC_API_KEY"]?.trim();
  if (k === undefined || k === "") {
    throw new Error("NEW_RELIC_API_KEY is not set");
  }
  return k;
}`);
  });

  it("applies transform before suffix", () => {
    const out = renderEnvAccessor(
      env({
        vars: ["SENTRY_URL"],
        local: "apiRoot",
        bindings: ["u"],
        default: "https://sentry.io",
        transform: "stripTrailingSlash",
        suffix: "/api/0",
      }),
    );
    expect(out).toBe(`function apiRoot(): string {
  const u = process.env["SENTRY_URL"]?.trim() || "https://sentry.io";
  return \`\${u.replace(/\\/$/, "")}/api/0\`;
}`);
  });

  it("renders a defaulted accessor with a prefix", () => {
    const out = renderEnvAccessor(
      env({
        vars: ["DD_SITE"],
        local: "siteHost",
        bindings: ["s"],
        default: "datadoghq.com",
        prefix: "api.",
      }),
    );
    expect(out).toContain('const s = process.env["DD_SITE"]?.trim() || "datadoghq.com";');
    expect(out).toContain("return `api.${s}`;");
  });

  it("returns a bare expression when there is no prefix or suffix", () => {
    const out = renderEnvAccessor(
      env({
        vars: ["GRAFANA_URL"],
        local: "baseUrl",
        bindings: ["u"],
        required: true,
        transform: "stripTrailingSlash",
      }),
    );
    expect(out).toContain('return u.replace(/\\/$/, "");');
    expect(out).not.toContain("`");
  });

  it("renders a bearer auth accessor", () => {
    const out = renderEnvAccessor(
      env({ vars: ["SENTRY_AUTH_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }),
    );
    expect(out).toBe(`function headers(): Record<string, string> {
  const t = process.env["SENTRY_AUTH_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("SENTRY_AUTH_TOKEN is not set");
  }
  return { Authorization: \`Bearer \${t}\`, Accept: "application/json" };
}`);
  });

  it("renders a multi-var header accessor with a joint error", () => {
    const out = renderEnvAccessor(
      env({
        vars: ["DD_API_KEY", "DD_APP_KEY"],
        local: "headers",
        bindings: ["ak", "app"],
        auth: "headers",
        headerNames: ["DD-API-KEY", "DD-APPLICATION-KEY"],
      }),
    );
    expect(out).toContain(
      'if (ak === undefined || ak === "" || app === undefined || app === "") {',
    );
    expect(out).toContain('throw new Error("DD_API_KEY and DD_APP_KEY must be set");');
    expect(out).toContain('"DD-API-KEY": ak,');
    expect(out).toContain('"DD-APPLICATION-KEY": app,');
    expect(out).toContain('Accept: "application/json",');
  });

  it("keeps a single-header accessor on one line, bitrise's shape", () => {
    const out = renderEnvAccessor(
      env({
        vars: ["BITRISE_TOKEN"],
        local: "authHeader",
        bindings: ["t"],
        auth: "headers",
        headerNames: ["Authorization"],
      }),
    );
    expect(out).toBe(`function authHeader(): Record<string, string> {
  const t = process.env["BITRISE_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("BITRISE_TOKEN is not set");
  }
  return { Authorization: t, Accept: "application/json" };
}`);
  });

  it("quotes a single header name that is not a bare identifier", () => {
    const out = renderEnvAccessor(
      env({
        vars: ["X_TOKEN"],
        local: "authHeader",
        bindings: ["t"],
        auth: "headers",
        headerNames: ["x-auth-token"],
      }),
    );
    expect(out).toContain('return { "x-auth-token": t, Accept: "application/json" };');
  });
});

describe("client-credentials", () => {
  const ccSpec = (over: Record<string, unknown> = {}) =>
    parseSpec({
      name: "zz",
      title: "Zz",
      displayName: "Zz",
      description: "d.",
      serviceLabel: "Zz",
      style: "hand-rolled",
      network: ["api.zz.test"],
      syncInterval: 300,
      minNimbusVersion: "0.2.0",
      env: [
        {
          vars: ["ZZ_CLIENT_ID", "ZZ_CLIENT_SECRET"],
          local: "authHeaders",
          bindings: ["id", "secret"],
          auth: "client-credentials",
          tokenUrl: "https://api.zz.test/token",
          scope: "items:read",
          credentialsIn: "basic",
          ...over,
        },
      ],
      fetchHelper: { local: "zzGet", base: "https://api.zz.test", headers: "authHeaders" },
      tools: [{ name: "zz_a", description: "A.", path: "/a" }],
    });

  it("requires exactly two vars", () => {
    expect(() => ccSpec({ vars: ["ONLY_ONE"] })).toThrow(/two/i);
  });

  it("rejects rest-kit style — the registrar resolves one bearer credential itself", () => {
    expect(() =>
      parseSpec({
        ...JSON.parse(JSON.stringify(ccSpec())),
        style: "rest-kit",
        fetchHelper: { local: "zzGet", base: "https://api.zz.test" },
      }),
    ).toThrow(/hand-rolled/);
  });

  it("emits a cached token function and a Bearer header", () => {
    const out = renderEnvAccessors(ccSpec());
    expect(out).toContain("let cachedToken: string | null = null");
    expect(out).toContain('grant_type: "client_credentials"');
    expect(out).toContain("Authorization: `Bearer ${await token()}`");
  });

  it("sends credentials as a Basic header when credentialsIn is basic", () => {
    // NOT `` Authorization: `Basic ${...}` `` — that shape is a hand-rolled base64
    // encode, exactly the `btoa`-style approach the brief warns against emitting.
    // `encodeBasicAuthHeader` already returns the complete "Basic <b64>" value, so it is
    // assigned directly, as a plain call, not interpolated into another template literal.
    expect(renderEnvAccessors(ccSpec())).toContain(
      "Authorization: encodeBasicAuthHeader(id, secret)",
    );
  });

  it("does not send a Basic header when credentialsIn is body", () => {
    const out = renderEnvAccessors(ccSpec({ credentialsIn: "body" }));
    expect(out).not.toContain("encodeBasicAuthHeader");
  });

  it("sends them in the form body when credentialsIn is body", () => {
    const out = renderEnvAccessors(ccSpec({ credentialsIn: "body" }));
    expect(out).toContain("client_secret");
    expect(out).not.toContain("Authorization: `Basic ${");
  });

  it("omits the scope line when the spec declares no scope", () => {
    const out = renderEnvAccessors(ccSpec({ scope: undefined }));
    expect(out).not.toContain("scope");
  });
});

describe("client-credentials token expiry", () => {
  const spec = (): Parameters<typeof renderEnvAccessor>[0] =>
    ({
      vars: ["X_ID", "X_SECRET"],
      local: "authHeaders",
      auth: "client-credentials",
      tokenUrl: "https://api.x.test/oauth/token",
      credentialsIn: "body",
      required: true,
    }) as Parameters<typeof renderEnvAccessor>[0];

  it("gates the cache on an expiry, not merely on the token being present", () => {
    // The cache used to be unconditional, with expires_in never read — correct only while
    // connectors stayed short-lived, which is a property of the caller rather than of this
    // code. Verified end to end by scripts/runtime-acceptance.ts, which observes a second
    // exchange after a 2-second token lapses.
    const out = renderEnvAccessor(spec(), "X");
    expect(out).toContain("let tokenExpiresAt = 0;");
    expect(out).toContain("if (cachedToken !== null && Date.now() < tokenExpiresAt)");
  });

  it("reads expires_in and renews early", () => {
    const out = renderEnvAccessor(spec(), "X");
    expect(out).toContain("expires_in?: unknown");
    expect(out).toContain("Math.min(60, Math.floor(parsed.expires_in / 2))");
  });

  it("falls back to the process lifetime when expires_in is absent", () => {
    // Not every token endpoint returns expires_in. Treating its absence as "expired" would
    // re-exchange on every single call.
    expect(renderEnvAccessor(spec(), "X")).toContain("Number.POSITIVE_INFINITY");
  });
});

describe("renderEnvAccessor, split bearer (tokenLocal)", () => {
  const split = () =>
    env({
      vars: ["MERCURY_TOKEN"],
      local: "authHeader",
      tokenLocal: "apiToken",
      bindings: ["t"],
      auth: "bearer",
    });

  it("emits the raw-token accessor and the header wrapper that calls it", () => {
    expect(renderEnvAccessor(split())).toBe(`function apiToken(): string {
  const t = process.env["MERCURY_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("MERCURY_TOKEN is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: \`Bearer \${apiToken()}\`, Accept: "application/json" };
}`);
  });

  it("leaves the fused single-function form untouched when tokenLocal is absent", () => {
    const out = renderEnvAccessor(
      env({ vars: ["GRAFANA_API_TOKEN"], local: "authHeaders", bindings: ["tok"], auth: "bearer" }),
    );
    expect(out).toBe(`function authHeaders(): Record<string, string> {
  const tok = process.env["GRAFANA_API_TOKEN"]?.trim();
  if (tok === undefined || tok === "") {
    throw new Error("GRAFANA_API_TOKEN is not set");
  }
  return { Authorization: \`Bearer \${tok}\`, Accept: "application/json" };
}`);
  });
});

describe("renderEnvAccessor, HTTP Basic", () => {
  it("reads and guards each variable separately, naming only the missing one", () => {
    const out = renderEnvAccessor(
      env({
        vars: ["AIRFLOW_USERNAME", "AIRFLOW_PASSWORD"],
        local: "authHeader",
        bindings: ["user", "password"],
        auth: "basic",
      }),
    );
    expect(out).toBe(`function authHeader(): Record<string, string> {
  const user = process.env["AIRFLOW_USERNAME"]?.trim();
  if (user === undefined || user === "") {
    throw new Error("AIRFLOW_USERNAME is not set");
  }
  const password = process.env["AIRFLOW_PASSWORD"]?.trim();
  if (password === undefined || password === "") {
    throw new Error("AIRFLOW_PASSWORD is not set");
  }
  return {
    Authorization: encodeBasicAuthHeader(user, password),
    Accept: "application/json",
  };
}`);
  });

  it("decorates the username with a suffix, which is what zendesk's /token is", () => {
    const out = renderEnvAccessor(
      env({
        vars: ["ZENDESK_EMAIL", "ZENDESK_API_TOKEN"],
        local: "authHeader",
        bindings: ["email", "token"],
        auth: "basic",
        suffix: "/token",
      }),
    );
    expect(out).toContain("Authorization: encodeBasicAuthHeader(`${email}/token`, token),");
  });

  it("requires exactly two vars — a username and a password", () => {
    expect(() => env({ vars: ["ONLY_ONE"], local: "authHeader", auth: "basic" })).toThrow(
      /exactly two \\"vars\\"/,
    );
  });
});

describe("renderEnvAccessors, trimTrailingSlashFn", () => {
  function spec(entries: unknown[]) {
    return parseSpec({
      name: "zendesk",
      displayName: "Zendesk",
      description: "d.",
      serviceLabel: "Zendesk",
      style: "read-only-kit",
      env: entries,
      fetchHelper: { local: "zendeskGet", base: "${env.baseUrl}", headers: "baseUrl" },
    });
  }

  const URL_ENTRY = {
    vars: ["ZENDESK_URL"],
    local: "baseUrl",
    bindings: ["v"],
    required: true,
    transform: "trimTrailingSlashFn",
  };

  it("emits the shared helper ahead of the accessor that calls it", () => {
    expect(
      renderEnvAccessors(spec([URL_ENTRY])),
    ).toBe(`function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function baseUrl(): string {
  const v = process.env["ZENDESK_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("ZENDESK_URL is not set");
  }
  return trimTrailingSlash(v);
}`);
  });

  it("emits the helper once however many accessors call it", () => {
    const out = renderEnvAccessors(
      spec([
        URL_ENTRY,
        { ...URL_ENTRY, vars: ["ZENDESK_ALT_URL"], local: "altUrl", bindings: ["w"] },
      ]),
    );
    expect(out.split("function trimTrailingSlash(").length - 1).toBe(1);
    expect(out).toContain("return trimTrailingSlash(w);");
  });

  it("leaves the inline .replace form — grafana's and sentry's — untouched", () => {
    const out = renderEnvAccessors(spec([{ ...URL_ENTRY, transform: "stripTrailingSlash" }]));
    expect(out).not.toContain("function trimTrailingSlash(");
    expect(out).toContain(String.raw`return v.replace(/\/$/, "");`);
  });
});
