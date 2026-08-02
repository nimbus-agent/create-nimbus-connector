import { describe, expect, it } from "bun:test";
import {
  renderBaseConst,
  renderFetchHelper,
  renderWriteHelper,
} from "../../../src/emit/server/fetch-helper.ts";
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

/**
 * Task 4 fix round 2, the GAP: `grep 'startsWith("http")' test/` used to return exactly one
 * hit — rest-kit's pre-existing, unconditional line. The read helper's own passthrough was
 * exercised only incidentally (emitted-typecheck's compile, the runtime harness); the write
 * helper's passthrough and the normalizeLeadingSlash-widened guard were covered by nothing —
 * and the widened guard is the one piece of the round-1 fix whose correctness rested on
 * argued operator precedence rather than execution. This describe block is what makes that
 * argument checkable.
 */
describe("query passthrough — hasQueryTool's gate on both fetch helpers", () => {
  const queryTool = {
    name: "t",
    description: "T.",
    path: "/items",
    args: { q: { type: "string" } },
    query: [{ name: "q", arg: "q" }],
  };
  const writeTool = {
    name: "w",
    description: "W.",
    path: "/items",
    method: "POST",
    effect: "write",
    args: { title: { type: "string" } },
  };

  it("the read helper emits the http passthrough when a query tool exists", () => {
    const out = renderFetchHelper(
      make({
        fetchHelper: { local: "xGet", base: "https://x.test", headers: "headers" },
        tools: [queryTool],
      }),
    );
    expect(out).toContain('const url = path.startsWith("http") ? path : `https://x.test${path}`;');
    expect(out).toContain("const res = await fetch(url, { headers: headers() });");
  });

  it("the write helper emits the http passthrough when a query tool exists", () => {
    const out = renderWriteHelper(
      make({
        fetchHelper: { local: "xGet", base: "https://x.test", headers: "headers" },
        tools: [queryTool, writeTool],
      }),
    );
    expect(out).toContain('const url = path.startsWith("http") ? path : `https://x.test${path}`;');
    expect(out).toContain("const res = await fetch(url, {");
  });

  it("widens the normalizeLeadingSlash guard so an absolute URL is never re-prefixed with a slash", () => {
    const out = renderFetchHelper(
      make({
        fetchHelper: {
          local: "xGet",
          base: "https://x.test",
          headers: "headers",
          normalizeLeadingSlash: true,
        },
        tools: [queryTool],
      }),
    );
    // Without the widened guard, an absolute URL (starts with "http", not "/") would fall
    // into the `else` branch and come out `/https://...`.
    expect(out).toContain(
      'const pathPart = path.startsWith("http") || path.startsWith("/") ? path : `/${path}`;',
    );
    expect(out).toContain(
      'const url = pathPart.startsWith("http") ? pathPart : `https://x.test${pathPart}`;',
    );
  });

  it("emits no passthrough in the read helper for a spec with no query tool — unchanged output", () => {
    const out = renderFetchHelper(
      make({
        fetchHelper: { local: "xGet", base: "https://x.test", headers: "headers" },
        tools: [{ name: "t", description: "T.", path: "/items" }],
      }),
    );
    expect(out).not.toContain('startsWith("http")');
    expect(out).toContain(
      "const res = await fetch(`https://x.test${path}`, { headers: headers() });",
    );
  });

  it("emits no passthrough in the write helper for a spec with no query tool — unchanged output", () => {
    const out = renderWriteHelper(
      make({
        fetchHelper: { local: "xGet", base: "https://x.test", headers: "headers" },
        tools: [writeTool],
      }),
    );
    expect(out).not.toContain('startsWith("http")');
    expect(out).toContain("const res = await fetch(`https://x.test${path}`, {");
  });
});

describe("renderBaseConst", () => {
  it("returns undefined when the spec does not ask for a hoisted base", () => {
    expect(
      renderBaseConst(
        make({ fetchHelper: { local: "xGet", base: "https://x.test", inlineHeaders: {} } }),
      ),
    ).toBeUndefined();
  });

  it("hoists the base to a module-scope const under the declared name", () => {
    const spec = make({
      fetchHelper: {
        local: "mercuryGet",
        base: "https://api.mercury.com",
        baseConst: "BASE",
        inlineHeaders: { Accept: "application/json" },
      },
      tools: [{ name: "m_list", description: "List accounts.", path: "/api/v1/accounts" }],
    });
    expect(renderBaseConst(spec)).toBe('const BASE = "https://api.mercury.com";');
  });

  it("omits the const when no helper is emitted to read it — an unread const fails tsc there", () => {
    const spec = make({
      fetchHelper: {
        local: "mercuryGet",
        base: "https://api.mercury.com",
        baseConst: "BASE",
        inlineHeaders: { Accept: "application/json" },
      },
      tools: [{ name: "m_todo", description: "Not implemented yet.", impl: "stub" }],
    });
    expect(renderBaseConst(spec)).toBeUndefined();
  });

  it("makes the helper reference the const instead of inlining the literal", () => {
    const spec = make({
      fetchHelper: {
        local: "bitriseGet",
        base: "https://api.bitrise.io",
        baseConst: "BITRISE_API",
        headers: "authHeader",
      },
      env: [
        {
          vars: ["BITRISE_TOKEN"],
          local: "authHeader",
          bindings: ["t"],
          auth: "headers",
          headerNames: ["Authorization"],
        },
      ],
    });
    expect(renderFetchHelper(spec)).toContain(
      "const res = await fetch(`${BITRISE_API}${path}`, { headers: authHeader() });",
    );
    expect(renderFetchHelper(spec)).not.toContain("https://api.bitrise.io");
  });

  it('rejects "baseConst" on a base that names ${env.X}, which resolves to an accessor call', () => {
    expect(() =>
      make({
        env: [{ vars: ["X_URL"], local: "baseUrl", bindings: ["u"], required: true }],
        fetchHelper: {
          local: "xGet",
          base: "${env.baseUrl}",
          baseConst: "BASE",
          headers: "baseUrl",
        },
      }),
    ).toThrow(/baseConst/);
  });
});
