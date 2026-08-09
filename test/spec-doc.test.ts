/**
 * `docs/SPEC.md`: that the checked-in page cannot drift from `ConnectorSpecSchema`, that it says
 * what it cannot say, and that the generator behind it fails loudly rather than printing a
 * half-derived table.
 *
 * The byte comparison is the whole gate for the first claim, and it is only worth something
 * because the test and the writer share `buildSpecDoc` AND `SPEC_DOC_PATH` — see
 * scripts/_lib/build-spec-doc.ts's header, and scripts/_lib/build-schema.ts's before it, for why a
 * drift test that reconstructs the document its own way proves nothing.
 *
 * The rest of this file is aimed at the generator, because a byte comparison cannot tell a correct
 * page from a page that agrees with a broken builder. Every guard the builder carries — the
 * unrendered-keyword sweep, `renderType`'s refusals, the gloss/schema agreement — is exercised on
 * the failing side here, since a guard whose only exercise is the passing case would go on
 * returning quietly if it were inverted.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_LIMITATION } from "../scripts/_lib/build-schema.ts";
import {
  anchor,
  assertEveryKeywordRendered,
  assertGlossesMatchSchema,
  buildSpecDoc,
  childSection,
  collectRules,
  glossGaps,
  renderType,
  SPEC_DOC_PATH,
  unrenderedKeywords,
} from "../scripts/_lib/build-spec-doc.ts";

const repoRoot = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

const page = buildSpecDoc();

/** Every `](#anchor)` target in a markdown source, and every heading anchor it offers. */
function linkTargets(markdown: string, file: string): string[] {
  return [...markdown.matchAll(/]\((?:([^)#]*))#([^)]+)\)/g)]
    .filter(([, target]) => (target ?? "") === file)
    .map(([, , fragment]) => fragment!);
}

function headingAnchors(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) => anchor(heading!.trim())),
  );
}

describe("the checked-in spec reference", () => {
  it("is byte-identical to what the generator produces, so the file cannot drift", () => {
    expect(readFileSync(SPEC_DOC_PATH, "utf8")).toBe(buildSpecDoc());
  });

  it("states its own limitation in the same words the schema and README use", () => {
    // The three have to travel together for the same reason test/schema.test.ts gives: a reader
    // who learns the reference exists and not that it is silent on every cross-field rule has been
    // handed a false green. Quoted verbatim rather than paraphrased, so there is one wording.
    expect(page).toContain(SCHEMA_LIMITATION);
    expect(page).toContain("cannot express");
    expect(page).toContain("src/validate.ts");
  });

  it("documents the fields the prose reference does not name", () => {
    // The gap this page exists to close: the prose reference called itself *the* reference while
    // these seven fields — each one with emitted behaviour of its own — were named in no prose
    // document in this repository at all. Measured with grep over README.md and every page under
    // docs/ at the commit this landed on; re-measured when the prose moved to SPEC-RULES.md, where
    // all seven are still absent, and both pages point here instead.
    //
    // Checked as a table ROW, not as a mention, since a mention is exactly what they had nowhere.
    // Deliberately NOT asserted absent from the prose pages: prose about one of them there would
    // be an improvement, and a test that failed on it would be pinning the gap rather than the fix.
    for (const field of [
      "handlerStyle",
      "baseConst",
      "staticPathStyle",
      "jsonFallbackRaw",
      "normalizeLeadingSlash",
      "headerNames",
      "tokenLocal",
    ]) {
      expect(page).toContain(`| \`${field}\``);
    }
  });

  it("gives every object in the schema a table of its own", () => {
    for (const heading of [
      "## `ConnectorSpec`",
      "## `filesystem`",
      "## `env[]`",
      "## `fetchHelper`",
      "## `tools[]`",
      "## `tools[].args.<name>`",
      "## `tools[].query[]`",
      "## `tools[].filter`",
    ]) {
      expect(page).toContain(heading);
    }
  });

  it("links only to sections it actually has", () => {
    // Same-document links are generated from the same path string as the heading, so this pins
    // the anchor derivation rather than the pairing — a heading text that stopped slugifying the
    // way the link does would fail here rather than on a reader's click.
    const missing = linkTargets(page, "").filter((a) => !headingAnchors(page).has(a));
    expect(missing).toEqual([]);
  });

  it("links into SPEC-RULES.md by headings SPEC-RULES.md still has", () => {
    // The failure this catches is a renamed prose heading, which nothing else in the suite sees.
    // The targets moved out of README.md when the prose reference became a page of its own, and
    // the check had to move with them: left pointing at README.md it would have gone on passing
    // against an empty link set forever, which is the vacuous-gate shape this repo keeps removing.
    const targets = linkTargets(page, "./SPEC-RULES.md");
    expect(targets.length).toBeGreaterThan(0);

    const anchors = headingAnchors(read("docs/SPEC-RULES.md"));
    expect(targets.filter((a) => !anchors.has(a))).toEqual([]);
  });

  it("is regenerable by a named script, and indexed where a reader would look", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["build:spec-doc"]).toBe("bun scripts/build-spec-doc.ts");
    // Both halves of the reference have to be indexed, not just this one. The prose half is a
    // separate page now, and a split whose second half nothing links to is a page nobody finds.
    for (const doc of ["SPEC.md", "SPEC-RULES.md"]) {
      expect(read("docs/README.md")).toContain(doc);
      // README's "the reference" sentence is what these pages exist to make true, so it has to
      // point at both. Asserted as the link, since a mention that does not resolve is what a
      // reader follows.
      expect(read("README.md")).toContain(`docs/${doc}`);
    }
  });

  it("has a row per field and nothing left blank", () => {
    // Non-vacuity for every assertion above: a builder that emitted headings and no rows would
    // satisfy the heading check, and one that emitted empty gloss cells would satisfy the field
    // check. `| |` is what a blank cell looks like once the row is assembled.
    const rows = page.split("\n").filter((l) => l.startsWith("| `"));
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.filter((l) => l.includes("| |"))).toEqual([]);
    expect(rows.every((l) => l.split(" | ").length === 5)).toBe(true);
  });
});

describe("the guards the generator carries", () => {
  it("refuses a keyword nothing on the page would render", () => {
    expect(unrenderedKeywords({ type: "string", pattern: "^a$" })).toEqual([]);
    expect(unrenderedKeywords({ oneOf: [], not: {} })).toEqual(["oneOf", "not"]);
  });

  it("sweeps the whole document for one, not only its root", () => {
    // The hole test/schema.test.ts found in its own version of this check: a sweep that visited
    // only the schemas a value descended into left `filesystem` and `filter` uninspected. Injected
    // deep enough that a root-only check cannot see it.
    const doc = JSON.parse(buildSpecDocSchemaShape()) as Record<string, unknown>;
    expect(() => assertEveryKeywordRendered(doc)).not.toThrow();

    const properties = doc["properties"] as Record<string, Record<string, unknown>>;
    (properties["tools"]!["items"] as Record<string, Record<string, unknown>>)["properties"]![
      "filter"
    ] = { oneOf: [] };
    expect(() => assertEveryKeywordRendered(doc)).toThrow(/nothing renders "oneOf" at .*filter/);
  });

  it("renders each shape the schema uses, and refuses the ones it does not model", () => {
    expect(renderType({ type: "string" })).toBe("string");
    expect(renderType({ type: "string", enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(renderType({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(
      renderType({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }),
    ).toBe("(string | number)[]");
    expect(renderType({ type: "object", additionalProperties: { type: "string" } })).toBe(
      "Record<string, string>",
    );
    expect(
      renderType({
        type: "object",
        required: ["a"],
        properties: { a: { type: "string" }, b: { type: "number" } },
      }),
    ).toBe("{ a: string; b?: number }");

    expect(() => renderType({ type: "array" })).toThrow("an array with no items");
    expect(() => renderType({ type: "object" })).toThrow("neither a record nor a shape");
    expect(() => renderType({})).toThrow("no type");
  });

  it("collects a constraint wherever it sits, and stops at the next table", () => {
    const items = { type: "object", properties: { a: { type: "string", minLength: 3 } } };
    const field = { type: "array", minItems: 1, items };
    // Without `stopAt`, the row for a field whose object has its own table would repeat that whole
    // table's rules.
    expect(collectRules(field, items)).toEqual(["minItems 1"]);
    expect(collectRules(field, undefined)).toEqual(["minItems 1", "items `a` minLength 3"]);

    expect(
      collectRules(
        {
          type: "object",
          propertyNames: { type: "string", pattern: "^k$" },
          additionalProperties: { type: "string", minLength: 1 },
        },
        undefined,
      ),
    ).toEqual(["keys matches `^k$`", "values minLength 1"]);

    expect(
      collectRules({ anyOf: [{ type: "string", minLength: 1 }, { type: "number" }] }, undefined),
    ).toEqual(["variant 1 minLength 1"]);
  });

  it("finds a table for an object, an array of objects and a record of objects, and no others", () => {
    const shape = { type: "object", properties: { a: { type: "string" } } };
    expect(childSection("filesystem", shape)?.path).toBe("filesystem");
    expect(childSection("env", { type: "array", items: shape })?.path).toBe("env[]");
    expect(
      childSection("tools[].args", { type: "object", additionalProperties: shape })?.path,
    ).toBe("tools[].args.<name>");
    expect(childSection("network", { type: "array", items: { type: "string" } })).toBeUndefined();
    expect(
      childSection("body", { type: "object", additionalProperties: { type: "string" } }),
    ).toBeUndefined();
  });

  it("fails the build when a gloss and the schema disagree, in either direction", () => {
    expect(glossGaps(["a", "b"], { a: "x", b: "y" })).toEqual({ missing: [], unknown: [] });
    expect(glossGaps(["a", "b"], { a: "x", c: "z" })).toEqual({ missing: ["b"], unknown: ["c"] });

    expect(() => assertGlossesMatchSchema(["a"], { a: "x" })).not.toThrow();
    expect(() => assertGlossesMatchSchema(["a", "b"], { a: "x" })).toThrow(/no gloss for: b/);
    expect(() => assertGlossesMatchSchema(["a"], { a: "x", z: "y" })).toThrow(/has not got: z/);
  });

  it("derives a heading anchor the way GitHub does for a field path", () => {
    expect(anchor("`tools[].args.<name>`")).toBe("toolsargsname");
    expect(anchor("`env[]`")).toBe("env");
    expect(anchor('Search tools: `impl: "search"`, `rows`')).toBe("search-tools-impl-search-rows");
  });
});

/** The published schema document, as text — the generator's own input, read the same way. */
function buildSpecDocSchemaShape(): string {
  return read("schema/connector-spec.schema.json");
}
