import { beforeAll, describe, expect, it } from "bun:test";
import { initParser } from "../../src/derive/ast.ts";
import { recognizeSearchFilter } from "../../src/derive/search-filter.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

let MONOREPO_SOURCE: string;

beforeAll(async () => {
  await initFormatter();
  await initParser();
  MONOREPO_SOURCE = emittedFilter(SPEC);
});

/**
 * One connector declaring all three filter forms (keyed, keyed-with-legacy-tags, bespoke
 * extractor over all four shared primitives) plus a throwing stub — so the emitted
 * src/search-filter.ts exercises every statement shape `recognizeSearchFilter` must walk, and
 * both search-specific imports (the stub forces the `mcp-search-tool.ts` one). `title` is
 * deliberately NOT the schema's own default (`capitalize("zzfilterunit")` is "Zzfilterunit", not
 * "ZzFilterUnit") so the type alias's title-recovery path is exercised, not merely present.
 */
const SPEC = {
  name: "zzfilterunit",
  title: "ZzFilterUnit",
  displayName: "ZZ Filter Unit",
  description: "Fixture for the search-filter recognizer.",
  serviceLabel: "ZZ Filter Unit",
  style: "read-only-kit",
  network: ["api.zzfilterunit.test"],
  syncInterval: 600,
  minNimbusVersion: "0.2.0",
  env: [{ vars: ["ZZFILTERUNIT_TOKEN"], local: "headers", auth: "bearer", required: true }],
  fetchHelper: { local: "zzGet", base: "https://api.zzfilterunit.test", headers: "headers" },
  tools: [
    {
      name: "zzfilterunit_keyed_search",
      description: "Keyed search.",
      impl: "search",
      path: "/v1/keyed",
      filter: { export: "filterZzfilterunitKeyed", fields: ["a", "b"] },
    },
    {
      name: "zzfilterunit_keyedtags_search",
      description: "Keyed search with legacy tags.",
      impl: "search",
      path: "/v1/keyedtags",
      filter: { export: "filterZzfilterunitKeyedtags", fields: ["c", "d"], tags: true },
    },
    {
      name: "zzfilterunit_extractor_search",
      description: "Extractor search over all four primitives.",
      impl: "search",
      path: "/v1/extractor",
      filter: {
        export: "filterZzfilterunitExtractor",
        fields: ["a", { path: ["b", "c"] }, { tags: "text" }, { tags: "objects" }],
      },
    },
    {
      name: "zzfilterunit_stub_search",
      description: "Stub search.",
      impl: "search",
      path: "/v1/stub",
      filter: { export: "filterZzfilterunitStub" },
    },
  ],
};

/** src/search-filter.ts as this repo's own emitter writes it, for the given target. */
function emittedFilter(spec: unknown, target?: "monorepo" | "standalone"): string {
  const files = formatAll(generate(parseSpec(spec), target === undefined ? {} : { target }));
  const f = files.find((x) => displayPath(x.path) === "src/search-filter.ts");
  if (f === undefined) throw new Error("no src/search-filter.ts emitted");
  return f.content;
}

describe("recognizeSearchFilter", () => {
  it("recovers the title fragment from the type alias", () => {
    const result = recognizeSearchFilter(MONOREPO_SOURCE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.titleFragment).toBe("ZzFilterUnit");
  });

  it("recovers the keyed form", () => {
    const result = recognizeSearchFilter(MONOREPO_SOURCE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.filters.find((f) => f.export === "filterZzfilterunitKeyed")).toEqual({
        export: "filterZzfilterunitKeyed",
        fields: ["a", "b"],
      });
    }
  });

  it("recovers the keyed form's legacy tags:true as a trailing { tags: \"text\" } entry — byte-identical either way (see emitSearchFilter's keyedShape)", () => {
    const result = recognizeSearchFilter(MONOREPO_SOURCE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.filters.find((f) => f.export === "filterZzfilterunitKeyedtags")).toEqual(
        {
          export: "filterZzfilterunitKeyedtags",
          fields: ["c", "d", { tags: "text" }],
        },
      );
    }
  });

  it("recovers the extractor form over all four shared primitives, in order", () => {
    const result = recognizeSearchFilter(MONOREPO_SOURCE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.filters.find((f) => f.export === "filterZzfilterunitExtractor")).toEqual(
        {
          export: "filterZzfilterunitExtractor",
          fields: ["a", { path: ["b", "c"] }, { tags: "text" }, { tags: "objects" }],
        },
      );
    }
  });

  it("recovers the throwing stub as fields: undefined", () => {
    const result = recognizeSearchFilter(MONOREPO_SOURCE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const stub = result.result.filters.find((f) => f.export === "filterZzfilterunitStub");
      expect(stub).toEqual({ export: "filterZzfilterunitStub" });
      expect(stub).not.toHaveProperty("fields");
    }
  });

  it("recovers all four filters in file (== spec.tools) order", () => {
    const result = recognizeSearchFilter(MONOREPO_SOURCE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.filters.map((f) => f.export)).toEqual([
        "filterZzfilterunitKeyed",
        "filterZzfilterunitKeyedtags",
        "filterZzfilterunitExtractor",
        "filterZzfilterunitStub",
      ]);
    }
  });

  it("recognizes the standalone target's single combined barrel import", () => {
    const result = recognizeSearchFilter(emittedFilter(SPEC, "standalone"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.filters).toHaveLength(4);
  });

  it("rejects a source that fails to parse", () => {
    const result = recognizeSearchFilter("this is not { valid typescript &&&");
    expect(result.ok).toBe(false);
  });

  it("rejects a file with no type alias at all", () => {
    const result = recognizeSearchFilter(
      'import { makeQueryFilter, fieldsFromKeys } from "../../shared/search-filter.ts";\n\n' +
        'export const filterX = makeQueryFilter(fieldsFromKeys(["a"]));\n',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers[0]?.kind).toBe("search-filter:no-type-alias");
  });

  it("rejects a file with a type alias and imports but zero filters — totality passes vacuously, so this is checked explicitly", () => {
    const result = recognizeSearchFilter(
      'import { type SearchMatchOptions } from "../../shared/search-filter.ts";\n\n' +
        "export type XSearchMatchOptions = SearchMatchOptions;\n",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers[0]?.kind).toBe("search-filter:no-filters");
  });

  it("rejects an import-list mismatch: the recognizer recomputes the import list from the body and requires the file to match it, naming the discrepancy as an ordinary unclaimed-import blocker", () => {
    // Drop "nestedString" from the primitives import — the body still calls it (the extractor's
    // path entry), so the actual import no longer matches what emitSearchFilter would have
    // written for this recognized body.
    const corrupted = MONOREPO_SOURCE.replace(/\n\s*nestedString,/, "\n");
    expect(corrupted).not.toBe(MONOREPO_SOURCE);
    const result = recognizeSearchFilter(corrupted);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.blockers.some((b) => b.kind === "import-from:../../shared/search-filter.ts"),
      ).toBe(true);
    }
  });

  it("rejects a quoted `tags` key in the keyed form's options object — emitSearchFilter writes it bare", () => {
    // `emitSearchFilter` hardcodes `, { tags: true }`. The objectProps parse resolves
    // `{ "tags": true }` to the same `key`, so the quoted spelling recovered the identical
    // trailing `{ tags: "text" }` FieldEntry and re-emitted the bare form — different bytes, an
    // unchanged spec, and no gate able to see it. `bareKeyedProps` (src/derive/read.ts) is the pin.
    const corrupted = MONOREPO_SOURCE.replace("{ tags: true }", '{ "tags": true }');
    expect(corrupted).not.toBe(MONOREPO_SOURCE);
    const result = recognizeSearchFilter(corrupted);
    expect(result.ok).toBe(false);
  });

  it("rejects a trailing statement the totality rule cannot account for", () => {
    const corrupted = `${MONOREPO_SOURCE}\nconst extra = 1;\n`;
    const result = recognizeSearchFilter(corrupted);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers.some((b) => b.kind === "statement:VariableDeclaration")).toBe(true);
    }
  });

  it("rejects an extractor carrying a hand-written doc comment — emitSearchFilter never writes one", () => {
    const corrupted = MONOREPO_SOURCE.replace(
      "function fieldsOf(item: unknown)",
      "/**\n * Hand-written doc comment.\n */\nfunction fieldsOf(item: unknown)",
    );
    expect(corrupted).not.toBe(MONOREPO_SOURCE);
    const result = recognizeSearchFilter(corrupted);
    expect(result.ok).toBe(false);
  });

  it("rejects an extractor guarded with asRecord instead of asObjectish", () => {
    const corrupted = MONOREPO_SOURCE.replace(/asObjectish/g, "asRecord");
    // MONOREPO_SOURCE is already asserted ok:true above, so a no-op replace here would still fail
    // expect(result.ok).toBe(false) loudly — this guard isn't about staying green, it's about
    // where the failure points: without it, a no-op reads "expected false, got true" (looks like
    // the recognizer); with it, "corrupted equals pristine" names the real cause (emitSearchFilter
    // stopped writing asObjectish).
    expect(corrupted).not.toBe(MONOREPO_SOURCE);
    const result = recognizeSearchFilter(corrupted);
    expect(result.ok).toBe(false);
  });

  it("rejects an extractor declared as an arrow with a type annotation instead of a named function", () => {
    const source = [
      'import { asObjectish, makeQueryFilter, type SearchMatchOptions, stringField } from "../../shared/search-filter.ts";',
      "",
      "export type XSearchMatchOptions = SearchMatchOptions;",
      "",
      "const fieldsOf: FieldExtractor = (item) => {",
      "  const row = asObjectish(item);",
      "  if (row === undefined) {",
      "    return null;",
      "  }",
      '  return [stringField(row, "a")];',
      "};",
      "",
      "export const filterX = makeQueryFilter(fieldsOf);",
    ].join("\n");
    const result = recognizeSearchFilter(source);
    expect(result.ok).toBe(false);
  });

  it("refuses an extractor whose entries are all plain keys — emitSearchFilter writes the KEYED form for that field list (resolveKeyedShape returns a shape), so this file is one the emitter cannot have produced", () => {
    const source = [
      'import { asObjectish, makeQueryFilter, type SearchMatchOptions, stringField } from "../../shared/search-filter.ts";',
      "",
      "export type XSearchMatchOptions = SearchMatchOptions;",
      "",
      "function fieldsOf(item: unknown): readonly string[] | null {",
      "  const row = asObjectish(item);",
      "  if (row === undefined) {",
      "    return null;",
      "  }",
      '  return [stringField(row, "a"), stringField(row, "b")];',
      "}",
      "",
      "export const filterX = makeQueryFilter(fieldsOf);",
    ].join("\n");
    const result = recognizeSearchFilter(source);
    expect(result.ok).toBe(false);
  });

  it("still accepts an extractor that is NOT keys-expressible — one nestedString entry is enough to make the extractor form the only one emitSearchFilter can write", () => {
    const source = [
      'import { asObjectish, makeQueryFilter, nestedString, type SearchMatchOptions, stringField } from "../../shared/search-filter.ts";',
      "",
      "export type XSearchMatchOptions = SearchMatchOptions;",
      "",
      "function fieldsOf(item: unknown): readonly string[] | null {",
      "  const row = asObjectish(item);",
      "  if (row === undefined) {",
      "    return null;",
      "  }",
      '  return [stringField(row, "a"), nestedString(row, ["b", "c"])];',
      "}",
      "",
      "export const filterX = makeQueryFilter(fieldsOf);",
    ].join("\n");
    const result = recognizeSearchFilter(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.filters[0]?.fields).toEqual(["a", { path: ["b", "c"] }]);
    }
  });
});

/**
 * The near misses each matcher has to refuse.
 *
 * Every case here is a file that has the right SHAPE and fails on one detail — a title alias
 * that carries no title, an extractor entry that is not one of the four primitives, a signature
 * or guard one token away from the emitted one, a stub arrow the emitter never writes. They are
 * the cases a shape-only match gets wrong, and getting one wrong is not a missed recognition: it
 * derives a spec that re-emits DIFFERENT bytes while `deriveSpec` reports `ok: true`, which is
 * the "claimed but not reproducible" defect the whole recognizer is built to avoid.
 *
 * The refusal is asserted as `function:fieldsOf` (or the equivalent unclaimed-statement kind)
 * rather than as bare `ok: false`, so a file that started failing for an unrelated reason — a
 * changed import list, a different blocker — does not keep the test green.
 */
describe("recognizeSearchFilter: near misses", () => {
  /** The extractor form with one clause substituted, and nothing else changed. */
  function extractorSource(options: {
    signature?: string;
    guard?: string;
    entries?: string;
  }): string {
    return [
      'import { asObjectish, makeQueryFilter, nestedString, type SearchMatchOptions, stringField } from "../../shared/search-filter.ts";',
      "",
      "export type XSearchMatchOptions = SearchMatchOptions;",
      "",
      options.signature ?? "function fieldsOf(item: unknown): readonly string[] | null {",
      "  const row = asObjectish(item);",
      options.guard ?? "  if (row === undefined) {",
      "    return null;",
      "  }",
      `  return ${options.entries ?? '[stringField(row, "a"), nestedString(row, ["b", "c"])]'};`,
      "}",
      "",
      "export const filterX = makeQueryFilter(fieldsOf);",
    ].join("\n");
  }

  it("refuses a type alias named exactly SearchMatchOptions — the recovered title would be the empty string", () => {
    // `matchTitleAlias` slices TITLE_SUFFIX off the alias name, so a self-alias recovers "" and
    // the caller would hand `spec.title = ""` to parseSpec. Refusing at the recognizer names the
    // construct; accepting it would report the file as blocked one tier down, by a schema error
    // that says nothing about the alias.
    const result = recognizeSearchFilter(
      [
        'import { fieldsFromKeys, makeQueryFilter, type SearchMatchOptions } from "../../shared/search-filter.ts";',
        "",
        "export type SearchMatchOptions = SearchMatchOptions;",
        "",
        'export const filterX = makeQueryFilter(fieldsFromKeys(["a", "b"]));',
      ].join("\n"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers[0]?.kind).toBe("search-filter:no-type-alias");
  });

  it("refuses a type alias that does not end in SearchMatchOptions, even with the right right-hand side", () => {
    const result = recognizeSearchFilter(
      [
        'import { fieldsFromKeys, makeQueryFilter, type SearchMatchOptions } from "../../shared/search-filter.ts";',
        "",
        "export type XOptions = SearchMatchOptions;",
        "",
        'export const filterX = makeQueryFilter(fieldsFromKeys(["a", "b"]));',
      ].join("\n"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers[0]?.kind).toBe("search-filter:no-type-alias");
  });

  it("refuses an extractor entry that is none of the four primitive calls", () => {
    // `renderEntry` writes exactly stringField / nestedString / tagText / tagNamesFromObjects.
    // A bare member access recovers no FieldEntry at all, so accepting the function around it
    // would silently DROP a field from the derived spec — the file would still look recognized.
    const result = recognizeSearchFilter(
      extractorSource({
        entries: '[stringField(row, "a"), nestedString(row, ["b", "c"]), row.custom]',
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers.map((b) => b.kind)).toContain("function:fieldsOf");
  });

  it("refuses an extractor whose parameter is annotated as something other than `unknown`", () => {
    // `matchesFieldsOfSignature` pins the parameter's annotation as well as its name:
    // emitSearchFilter writes `fieldsOf(item: unknown)` and nothing else, so a narrower
    // annotation is a byte the generator cannot reproduce — and it is the plausible hand-edit,
    // since `Record<string, unknown>` is what the body actually needs.
    const result = recognizeSearchFilter(
      extractorSource({
        signature: "function fieldsOf(item: Record<string, unknown>): readonly string[] | null {",
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers.map((b) => b.kind)).toContain("function:fieldsOf");
  });

  it("refuses an extractor guarded on `row === null` rather than `row === undefined`", () => {
    // asObjectish returns undefined, never null, so the null guard is dead code in the file's
    // own terms — and re-emitting it as the undefined form would change bytes. This is the same
    // "reject rather than normalize" rule the asRecord case above applies to the guard's callee.
    const result = recognizeSearchFilter(extractorSource({ guard: "  if (row === null) {" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers.map((b) => b.kind)).toContain("function:fieldsOf");
  });

  it("refuses a throwing stub declared as an async arrow — stubFilter writes a synchronous one", () => {
    // makeQueryFilter's contract is synchronous; an async stub returns a rejected promise the
    // filter never awaits, so the tool reports success. Recovering it as the ordinary stub would
    // re-emit the synchronous form and quietly change the generated package's behaviour.
    const corrupted = MONOREPO_SOURCE.replace(
      "filterZzfilterunitStub: SearchFilter = () => {",
      "filterZzfilterunitStub: SearchFilter = async () => {",
    );
    expect(corrupted).not.toBe(MONOREPO_SOURCE);

    const result = recognizeSearchFilter(corrupted);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers.map((b) => b.kind)).toContain("statement:ExportNamedDeclaration");
    }
  });
});
