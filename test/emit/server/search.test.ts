import { describe, expect, it } from "bun:test";
import { emitServer } from "../../../src/emit/server/index.ts";
import { renderSearchTool } from "../../../src/emit/server/search.ts";
import { parseSpec } from "../../../src/spec.ts";

function make(tool: Record<string, unknown>, over: Record<string, unknown> = {}) {
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
      // Mercury is one of the 8 corpus connectors that render a fully-static path as a
      // backtick template literal (mercury_list, mercury_get, mercury_search all do this) —
      // a per-connector convention, not a search-tool property. See path-template.test.ts's
      // "staticStyle" suite for the default ("quoted") behaviour this overrides.
      staticPathStyle: "template",
    },
    tools: [tool],
    ...over,
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

  it('breaks the merged schema one field per line under argsSchemaStyle "expanded"', () => {
    // bitrise's real shape: its own arg first, then the two fields searchToolInputSchema
    // would have supplied, all in one declaration that takes the connector's convention.
    const out = make(
      {
        name: "bitrise_search",
        description: "Search builds.",
        impl: "search",
        args: { appSlug: { type: "string", min: 1 } },
        maxLimit: 200,
        path: "/v0.1/apps/${arg.appSlug|enc}/builds?limit=50",
        filter: { export: "filterBitriseBuilds", fields: ["branch"] },
      },
      { argsSchemaStyle: "expanded" },
    );
    expect(out).toContain(
      "  z.object({\n" +
        "  appSlug: z.string().min(1),\n" +
        "  query: z.string().min(1),\n" +
        "  limit: z.number().int().min(1).max(200).optional(),\n" +
        "}),",
    );
  });
});

function specWith(tools: unknown[], style = "read-only-kit") {
  return parseSpec({
    name: "mercury",
    displayName: "Mercury",
    description: "d.",
    serviceLabel: "Mercury",
    style,
    fetchHelper: {
      local: "mercuryGet",
      base: "https://api.mercury.com",
      inlineHeaders: { Accept: "application/json" },
    },
    tools,
  });
}

const SEARCH = {
  name: "mercury_search",
  description: "Search accounts.",
  impl: "search",
  path: "/api/v1/accounts",
  rows: "accounts",
  filter: { export: "filterMercuryAccounts", fields: ["id"] },
};

describe("emitServer search imports", () => {
  it("imports both search helpers and the filter, monorepo", () => {
    const out = emitServer(specWith([SEARCH]), "monorepo").content;
    expect(out).toContain(
      'import { matchesResult, searchToolInputSchema } from "../../shared/mcp-search-tool.ts";',
    );
    expect(out).toContain('import { filterMercuryAccounts } from "./search-filter.ts";');
  });

  it("omits searchToolInputSchema when every search tool inlines its schema", () => {
    const out = emitServer(
      specWith([
        { ...SEARCH, args: { appSlug: { type: "string", min: 1 } }, path: "/a/${arg.appSlug}/b" },
      ]),
      "monorepo",
    ).content;
    expect(out).toContain('import { matchesResult } from "../../shared/mcp-search-tool.ts";');
    expect(out).not.toContain("searchToolInputSchema");
  });

  it("imports matchesResult from the SDK kit on standalone, in Biome's real merged order", () => {
    const out = emitServer(specWith([SEARCH]), "standalone").content;
    expect(out).not.toContain("../../shared/");
    // Pinned, not just toContain("matchesResult") — Biome buckets by the case-folded first
    // character of each local name and puts `type` imports ahead of value imports within a
    // shared bucket, so "type McpListResult" sorts before "matchesResult" despite 'a' < 'c'
    // at the second character. See task-7-report.md, "Finding A".
    expect(out).toContain(
      [
        "import {",
        "  createRegisterSimpleTool,",
        "  createZodToolRegistrar,",
        "  type McpListResult,",
        "  matchesResult,",
        "  type SearchMatchOptions,",
        "  type ZodObjectSchema,",
        '} from "@nimbus-dev/sdk/connector-kit";',
      ].join("\n"),
    );
    expect(out).toContain('import { filterMercuryAccounts } from "./search-filter.js";');
  });

  it("defines searchToolInputSchema locally on standalone rather than importing it", () => {
    // The SDK deliberately does not export it — it constructs a zod schema, and
    // @nimbus-dev/sdk ships zero runtime dependencies. Importing it anyway typechecked in no
    // configuration and failed the bundler too; standalone acceptance is what caught it.
    const out = emitServer(specWith([SEARCH]), "standalone").content;
    expect(out).not.toContain('searchToolInputSchema,\n} from "@nimbus-dev/sdk/connector-kit"');
    expect(out).toContain(
      "function searchToolInputSchema(maxLimit: number): ZodObjectSchema<SearchMatchOptions> {",
    );
    // The return-type annotation is what fixes `p` to SearchMatchOptions at the call site, so
    // the glue must import zod even for a spec whose every tool is a zero-arg search tool —
    // the one shape usesZod() would otherwise exclude.
    expect(out).toContain('import { z } from "zod";');
    expect(out).toContain("searchToolInputSchema(100)");
  });

  it("keeps importing the shared helper on monorepo, where it does resolve", () => {
    const out = emitServer(specWith([SEARCH]), "monorepo").content;
    expect(out).toContain(
      'import { matchesResult, searchToolInputSchema } from "../../shared/mcp-search-tool.ts";',
    );
    expect(out).not.toContain("function searchToolInputSchema(");
  });

  it("alphabetises the filter names, which Biome's organizeImports requires", () => {
    // Declared items-then-events; emitted events-then-items. A single-filter connector cannot
    // see this, which is why every golden fixture stayed green while it was wrong.
    const out = emitServer(
      specWith([
        { ...SEARCH, name: "mercury_b_search", filter: { export: "filterItems", fields: ["id"] } },
        {
          ...SEARCH,
          name: "mercury_a_search",
          path: "/api/v1/events",
          filter: { export: "filterEvents", fields: ["id"] },
        },
      ]),
      "monorepo",
    ).content;
    expect(out).toContain('import { filterEvents, filterItems } from "./search-filter.ts";');
  });

  it("imports both search helpers and the filter for a HAND-ROLLED connector too", () => {
    // `handRolledImportLines` carries its own copy of the search block and the filter block;
    // the read-only-kit assertions above prove nothing about it, and no fixture combines
    // `style: "hand-rolled"` with a search tool (checked across fixtures/*.spec.json), so this
    // is the only thing standing between a dropped block and a generated `src/server.ts` that
    // calls matchesResult/searchToolInputSchema without importing them — TS2304 in the
    // generated package, and invisible to every golden snapshot.
    const out = emitServer(specWith([SEARCH], "hand-rolled"), "monorepo").content;
    expect(out).toContain(
      'import { matchesResult, searchToolInputSchema } from "../../shared/mcp-search-tool.ts";',
    );
    expect(out).toContain('import { filterMercuryAccounts } from "./search-filter.ts";');
    // Sorted with the rest of the relative-import group rather than appended after it.
    expect(out.indexOf("mcp-search-tool.ts")).toBeLessThan(out.indexOf("mcp-tool-kit.ts"));
  });

  it("emits no search imports for a spec with no search tool", () => {
    const out = emitServer(
      specWith([{ name: "mercury_list", description: "List.", path: "/api/v1/accounts" }]),
      "monorepo",
    ).content;
    expect(out).not.toContain("mcp-search-tool");
    expect(out).not.toContain("search-filter");
  });
});
