import { describe, expect, it } from "bun:test";
import { renderSearchTool } from "../../../src/emit/server/search.ts";
import { parseSpec } from "../../../src/spec.ts";

function make(tool: Record<string, unknown>) {
  const spec = parseSpec({
    name: "mercury",
    displayName: "Mercury",
    description: "d.",
    serviceLabel: "Mercury",
    style: "read-only-kit",
    fetchHelper: {
      local: "mercuryGet",
      base: "https://api.mercury.com",
      inlineHeaders: { Accept: "application/json" },
    },
    tools: [tool],
  });
  return renderSearchTool(spec, spec.tools[0]!);
}

describe("renderSearchTool", () => {
  it("uses searchToolInputSchema and plucks the envelope when rows is set", () => {
    const out = make({
      name: "mercury_search",
      description: "Search accounts.",
      impl: "search",
      path: "/api/v1/accounts",
      rows: "accounts",
      filter: { export: "filterMercuryAccounts", fields: ["id"] },
    });
    expect(out).toContain("searchToolInputSchema(100)");
    expect(out).toContain("const root = await mercuryGet(`/api/v1/accounts`);");
    expect(out).toContain("const accounts = (root as { accounts?: unknown[] } | null)?.accounts;");
    expect(out).toContain("return matchesResult(accounts, filterMercuryAccounts, p);");
  });

  it("passes the response straight through when rows is omitted", () => {
    const out = make({
      name: "mercury_search",
      description: "Search accounts.",
      impl: "search",
      path: "/api/v1/accounts",
      filter: { export: "filterMercuryAccounts", fields: ["id"] },
    });
    expect(out).not.toContain("const root =");
    expect(out).toContain(
      "return matchesResult(await mercuryGet(`/api/v1/accounts`), filterMercuryAccounts, p);",
    );
  });

  it("honours a custom maxLimit", () => {
    const out = make({
      name: "mercury_search",
      description: "Search accounts.",
      impl: "search",
      path: "/api/v1/accounts",
      maxLimit: 2000,
      filter: { export: "filterMercuryAccounts", fields: ["id"] },
    });
    expect(out).toContain("searchToolInputSchema(2000)");
  });

  it("inlines the schema when the tool declares its own args", () => {
    const out = make({
      name: "bitrise_build_search",
      description: "Search builds.",
      impl: "search",
      args: { appSlug: { type: "string", min: 1 } },
      path: "/v0.1/apps/${arg.appSlug}/builds",
      filter: { export: "filterBitriseBuilds", fields: ["branch"] },
    });
    expect(out).not.toContain("searchToolInputSchema");
    expect(out).toContain("appSlug: z.string().min(1)");
    expect(out).toContain("query: z.string().min(1)");
    expect(out).toContain("limit: z.number().int().min(1).max(100).optional()");
  });
});
