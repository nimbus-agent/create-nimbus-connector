import { describe, expect, it } from "bun:test";
import { renderFetchHelper } from "../../../src/emit/server/fetch-helper.ts";
import { parseSpec } from "../../../src/spec.ts";

function make(over: Record<string, unknown>) {
  return parseSpec({
    name: "x",
    displayName: "X",
    description: "d.",
    serviceLabel: "X",
    style: "hand-rolled",
    fetchHelper: { local: "xGet", base: "https://x.test" },
    ...over,
  });
}

describe("renderFetchHelper", () => {
  it("renders inline headers against a literal base", () => {
    const out = renderFetchHelper(
      make({
        serviceLabel: "New Relic",
        fetchHelper: {
          local: "nrGet",
          base: "https://api.newrelic.com",
          inlineHeaders: { "X-Api-Key": "${env.apiKey}", Accept: "application/json" },
        },
      }),
    );
    expect(out).toContain("async function nrGet(path: string): Promise<unknown> {");
    expect(out).toContain("const res = await fetch(`https://api.newrelic.com${path}`, {");
    expect(out).toContain('headers: { "X-Api-Key": apiKey(), Accept: "application/json" },');
    expect(out).toContain(
      "throw new Error(`New Relic ${String(res.status)}: ${text.slice(0, 400)}`);",
    );
    expect(out).toContain("return JSON.parse(text) as unknown;");
  });

  it("inlines the options object when there is no leading-slash normalisation", () => {
    const out = renderFetchHelper(
      make({
        serviceLabel: "Sentry",
        fetchHelper: { local: "sentryGet", base: "${env.apiRoot}", headers: "headers" },
      }),
    );
    expect(out).toContain(
      "const res = await fetch(`${apiRoot()}${path}`, { headers: headers() });",
    );
  });

  it("expands the options object and normalises the path when asked", () => {
    const out = renderFetchHelper(
      make({
        serviceLabel: "Grafana",
        fetchHelper: {
          local: "grafanaGet",
          base: "${env.baseUrl}",
          headers: "authHeaders",
          normalizeLeadingSlash: true,
          jsonFallbackRaw: true,
        },
      }),
    );
    expect(out).toContain('const pathPart = path.startsWith("/") ? path : `/${path}`;');
    expect(out).toContain(
      "const res = await fetch(`${baseUrl()}${pathPart}`, {\n    headers: authHeaders(),\n  });",
    );
    expect(out).toContain(
      "  try {\n    return JSON.parse(text) as unknown;\n  } catch {\n    return { raw: text };\n  }",
    );
  });

  it("emits the token-taking signature makeRestToolRegistrar requires for rest-kit", () => {
    const out = renderFetchHelper(
      make({
        style: "rest-kit",
        serviceLabel: "Discord",
        env: [{ vars: ["DISCORD_BOT_TOKEN"], local: "hdrs", bindings: ["t"], auth: "bearer" }],
        fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
      }),
    );
    expect(out).toContain(
      "async function discordFetch(\n  token: string,\n  path: string,\n  init?: RequestInit,\n)",
    );
    expect(out).toContain(
      "Promise<{ ok: boolean; status: number; json: unknown; text: string }> {",
    );
    expect(out).toContain(
      'const url = path.startsWith("http") ? path : `https://discord.com/api/v10${path}`;',
    );
    expect(out).toContain("return { ok: res.ok, status: res.status, json, text };");
  });

  it("does not throw on non-2xx in rest-kit style — mcpJsonResultIfOk owns that", () => {
    const out = renderFetchHelper(
      make({
        style: "rest-kit",
        env: [{ vars: ["T"], local: "hdrs", bindings: ["t"], auth: "bearer" }],
        fetchHelper: { local: "xFetch", base: "https://x.test" },
      }),
    );
    expect(out).not.toContain("throw new Error");
    expect(out).not.toContain("if (!res.ok)");
  });
});
