import { describe, expect, it } from "bun:test";
import { emitSearchFilter } from "../../src/emit/search-filter.ts";
import { parseSpec } from "../../src/spec.ts";

function make(tools: unknown[]) {
  return parseSpec({
    name: "mercury",
    title: "Mercury",
    displayName: "Mercury",
    description: "d.",
    serviceLabel: "Mercury",
    style: "read-only-kit",
    fetchHelper: {
      local: "mercuryGet",
      base: "https://api.mercury.com",
      inlineHeaders: { Accept: "application/json" },
    },
    tools,
  });
}

const KEYED = {
  name: "mercury_search",
  description: "Search.",
  impl: "search",
  path: "/api/v1/accounts",
  filter: { export: "filterMercuryAccounts", fields: ["id", "name"] },
};

describe("emitSearchFilter", () => {
  it("returns undefined for a spec with no search tool", () => {
    expect(
      emitSearchFilter(
        make([{ name: "mercury_list", description: "List.", path: "/api/v1/accounts" }]),
        "monorepo",
      ),
    ).toBeUndefined();
  });

  it("emits the fieldsFromKeys shape at src/search-filter.ts", () => {
    const file = emitSearchFilter(make([KEYED]), "monorepo")!;
    expect(file.path).toEqual(["src", "search-filter.ts"]);
    expect(file.content).toContain('} from "../../shared/search-filter.ts";');
    expect(file.content).toContain("export type MercurySearchMatchOptions = SearchMatchOptions;");
    expect(file.content).toContain(
      'export const filterMercuryAccounts = makeQueryFilter(\n  fieldsFromKeys(["id", "name"]),\n);',
    );
  });

  it("passes { tags: true } through", () => {
    const file = emitSearchFilter(
      make([{ ...KEYED, filter: { export: "f", fields: ["id"], tags: true } }]),
      "monorepo",
    )!;
    expect(file.content).toContain('fieldsFromKeys(["id"], { tags: true })');
  });

  it("emits a throwing filter, not a throwing extractor, when fields is omitted", () => {
    const file = emitSearchFilter(
      make([{ ...KEYED, filter: { export: "filterMercuryAccounts" } }]),
      "monorepo",
    )!;
    expect(file.content).not.toContain("makeQueryFilter");
    expect(file.content).not.toContain("fieldsFromKeys");
    expect(file.content).toContain("export const filterMercuryAccounts: SearchFilter = () => {");
    expect(file.content).toContain("throw new Error(");
  });

  it("imports the kit for the standalone target", () => {
    const file = emitSearchFilter(make([KEYED]), "standalone")!;
    expect(file.content).toContain('} from "@nimbus-dev/sdk/connector-kit";');
    expect(file.content).not.toContain("../../shared/");
  });

  it("emits one export per search tool", () => {
    const file = emitSearchFilter(
      make([
        KEYED,
        {
          ...KEYED,
          name: "mercury_search_two",
          path: "/api/v1/cards",
          filter: { export: "filterMercuryCards", fields: ["id"] },
        },
      ]),
      "monorepo",
    )!;
    expect(file.content).toContain("export const filterMercuryAccounts");
    expect(file.content).toContain("export const filterMercuryCards");
  });

  it("does not import type SearchFilter on standalone when every search tool is keyed", () => {
    const file = emitSearchFilter(make([KEYED]), "standalone")!;
    expect(file.content).not.toContain("SearchFilter");
    expect(file.content).toContain('} from "@nimbus-dev/sdk/connector-kit";');
  });

  it("imports SearchFilter from mcp-search-tool, not search-filter, on monorepo", () => {
    const file = emitSearchFilter(
      make([{ ...KEYED, filter: { export: "filterMercuryAccounts" } }]),
      "monorepo",
    )!;
    expect(file.content).toContain(
      'import { type SearchFilter } from "../../shared/mcp-search-tool.ts";',
    );
    // Pinned against the exact import clause, not a multi-line regex: with both required
    // import lines present (mcp-search-tool.ts for SearchFilter, search-filter.ts for
    // SearchMatchOptions), a non-greedy "SearchFilter...from search-filter.ts" pattern spans
    // across the two unrelated lines and always matches — it would flag a correct emitter as
    // broken. Asserting the search-filter.ts import's exact content is what actually pins
    // the split.
    expect(file.content).toContain(
      'import { type SearchMatchOptions } from "../../shared/search-filter.ts";',
    );
  });
});
