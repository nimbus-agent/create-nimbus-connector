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

const PATHS = {
  ...KEYED,
  filter: {
    export: "filterMercuryAccounts",
    fields: ["name", { path: ["spec", "source", "repoURL"] }],
  },
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

  it("emits a fieldsOf extractor when a path entry is present", () => {
    const file = emitSearchFilter(make([PATHS]), "monorepo")!;
    expect(file.content).toContain("function fieldsOf(item: unknown): readonly string[] | null {");
    expect(file.content).toContain("const row = asObjectish(item);");
    expect(file.content).toContain('stringField(row, "name")');
    expect(file.content).toContain('nestedString(row, ["spec", "source", "repoURL"])');
    expect(file.content).toContain(
      "export const filterMercuryAccounts = makeQueryFilter(fieldsOf);",
    );
  });

  it("renders each tag format with its own helper", () => {
    const objects = emitSearchFilter(
      make([{ ...KEYED, filter: { export: "f", fields: ["a", { tags: "objects" }] } }]),
      "monorepo",
    )!;
    expect(objects.content).toContain("tagNamesFromObjects(row)");

    const midText = emitSearchFilter(
      make([{ ...KEYED, filter: { export: "f", fields: [{ tags: "text" }, "a"] } }]),
      "monorepo",
    )!;
    expect(midText.content).toContain("tagText(row)");
    expect(midText.content).toContain("function fieldsOf(");
  });

  it("falls back to fieldsOf for multiple tag entries", () => {
    // Only a SINGLE trailing {tags:"text"} converges, because fieldsFromKeys appends exactly one
    // tagText. Two tag entries cannot be expressed by it, whatever their order.
    const twoText = emitSearchFilter(
      make([
        { ...KEYED, filter: { export: "f", fields: ["a", { tags: "text" }, { tags: "text" }] } },
      ]),
      "monorepo",
    )!;
    expect(twoText.content).toContain("function fieldsOf(");
    expect(twoText.content).not.toContain("fieldsFromKeys");

    const mixed = emitSearchFilter(
      make([
        { ...KEYED, filter: { export: "f", fields: ["a", { tags: "text" }, { tags: "objects" }] } },
      ]),
      "monorepo",
    )!;
    expect(mixed.content).toContain("function fieldsOf(");
    expect(mixed.content).toContain("tagText(row)");
    expect(mixed.content).toContain("tagNamesFromObjects(row)");
  });

  it("converges a trailing {tags:'text'} with legacy tags:true, byte for byte", () => {
    const entry = emitSearchFilter(
      make([{ ...KEYED, filter: { export: "f", fields: ["id", { tags: "text" }] } }]),
      "monorepo",
    )!;
    const legacy = emitSearchFilter(
      make([{ ...KEYED, filter: { export: "f", fields: ["id"], tags: true } }]),
      "monorepo",
    )!;
    expect(entry.content).toBe(legacy.content);
    expect(entry.content).toContain('fieldsFromKeys(["id"], { tags: true })');
    expect(entry.content).not.toContain("fieldsOf");
  });

  it("imports only the primitives the entries actually use", () => {
    const file = emitSearchFilter(make([PATHS]), "monorepo")!;
    expect(file.content).toContain("nestedString");
    expect(file.content).not.toContain("tagText");
    expect(file.content).not.toContain("tagNamesFromObjects");
    // The emitted form is a function declaration that annotates its own signature, and the
    // guard is always asObjectish.
    expect(file.content).not.toContain("FieldExtractor");
    expect(file.content).not.toContain("asRecord");
  });

  it("resolves the extractor primitives from the kit on standalone", () => {
    const file = emitSearchFilter(make([PATHS]), "standalone")!;
    expect(file.content).toContain('} from "@nimbus-dev/sdk/connector-kit";');
    expect(file.content).not.toContain("../../shared/search-filter.ts");
  });

  it("leaves a plain-string-only filter on the fieldsFromKeys path", () => {
    const file = emitSearchFilter(make([KEYED]), "monorepo")!;
    expect(file.content).not.toContain("fieldsOf");
    expect(file.content).toContain('fieldsFromKeys(["id", "name"])');
  });
});
