/**
 * The published `ConnectorSpec` JSON Schema: that the checked-in file cannot drift from the
 * generator, and that the gap between the schema and `parseSpec` is a known, stated quantity
 * rather than something a user discovers when the CLI refuses a file their editor called clean.
 *
 * The second half is the point. `z.toJSONSchema` drops every `.refine`/`.superRefine`, so the
 * published document is strictly more permissive than the generator. That cannot be fixed — JSON
 * Schema cannot say "this field is only valid when that one is set" — so it is pinned here, with
 * two real specs that fall through the gap, and stated in the document's own `description` and in
 * README.md. See scripts/_lib/build-schema.ts's header for the full reasoning.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSchema,
  SCHEMA_ID,
  SCHEMA_LIMITATION,
  SCHEMA_PATH,
} from "../scripts/_lib/build-schema.ts";
import { parseSpec } from "../src/spec.ts";
import { validateSpec } from "../src/validate.ts";

const repoRoot = join(import.meta.dir, "..");

/* ------------------------------------------------------------------------------------------ *
 * A minimal structural check, and the limits of what it proves.
 *
 * `schemaWouldAccept` below is NOT a JSON Schema validator. It models seven keywords — `type`,
 * `enum`, `anyOf`, `properties`, `required`, `additionalProperties` and `items` — and ignores the
 * rest. A full validator would mean a dependency this repo does not carry, and the claim being
 * made does not need one: showing that a spec survives even the structural rules is enough to
 * show the published schema lets it through, since every keyword this checker ignores can only
 * ever reject MORE, never less.
 *
 * So read the gap tests below for what they are. They prove the gap EXISTS, in the two cases they
 * name. They do not measure its extent, and no test here does — the extent is "every refinement in
 * src/spec.ts", which is why the limitation is documented rather than enumerated.
 *
 * The unmodelled-keyword throw is what stops this from quietly becoming a check of nothing. A
 * checker that shrugged at a keyword it did not understand would keep returning `true` as the spec
 * language grew, and the gap tests would go on passing while asserting less and less each time —
 * the exact false green the tests are written to expose one level up.
 *
 * That guard runs at MODULE LOAD, over every subschema in the document, and this is the second
 * version of it. The first checked keywords inside `accepts()`, which iterates the *spec value's*
 * entries — so it only ever visited the subschemas a test's own values descend into. Measured:
 * injecting `oneOf: []` into `properties.filesystem.properties.read` and into
 * `tools.items.properties.filter` — neither traversed by any value here — left all sixteen tests
 * green, while the comment claimed document-wide reach. `assertNoUnmodelledKeyword` below walks
 * the whole document once instead, so an unrecognised keyword anywhere fails this FILE rather
 * than one test; and "sweeps the whole published document" pins the walk's own reach, since a
 * walk that descended nowhere would be exactly as blind as the guard it replaces.
 * ------------------------------------------------------------------------------------------ */

type JsonSchema = Record<string, unknown>;

/** Modelled: a value is checked against each of these. */
const ENFORCED_KEYWORDS = new Set([
  "type",
  "enum",
  "anyOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
]);

/**
 * Not modelled, and knowingly so. Every one of these can only narrow what is accepted, so
 * ignoring them makes this checker MORE permissive than the published schema — which is the safe
 * direction for the claim the gap tests make, and the wrong direction for any other claim. Do not
 * reach for this helper to argue that something IS accepted by a real validator.
 */
const IGNORED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "default",
  "pattern",
  "format",
  "propertyNames",
  "minLength",
  "minItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
]);

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    default:
      throw new Error(`schemaWouldAccept: unmodelled "type": ${JSON.stringify(type)}`);
  }
}

function acceptsObject(schema: JsonSchema, value: Record<string, unknown>): boolean {
  const properties = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
  for (const key of (schema["required"] ?? []) as string[]) {
    if (!Object.hasOwn(value, key)) return false;
  }
  const extra = schema["additionalProperties"];
  for (const [key, sub] of Object.entries(value)) {
    const propSchema = properties[key];
    if (propSchema !== undefined) {
      if (!accepts(propSchema, sub)) return false;
      continue;
    }
    if (extra === false) return false;
    if (typeof extra === "object" && extra !== null && !accepts(extra as JsonSchema, sub)) {
      return false;
    }
  }
  return true;
}

/** The keywords of one subschema that neither list names. Empty is the only acceptable answer. */
function unmodelledKeywords(schema: JsonSchema): string[] {
  return Object.keys(schema).filter((k) => !ENFORCED_KEYWORDS.has(k) && !IGNORED_KEYWORDS.has(k));
}

function unmodelledKeywordError(keyword: string, where: string): Error {
  return new Error(
    `schemaWouldAccept: unmodelled keyword ${JSON.stringify(keyword)} at ${where}. The spec ` +
      "language grew a construct this checker does not understand; model it or add it to " +
      "IGNORED_KEYWORDS deliberately, rather than letting the check pass on it silently.",
  );
}

function accepts(schema: JsonSchema, value: unknown): boolean {
  // Still checked per call, because `accepts` is also handed schemas built inline by the tests
  // below, which the module-load sweep never sees. The document-wide claim is the sweep's.
  const unmodelled = unmodelledKeywords(schema)[0];
  if (unmodelled !== undefined) throw unmodelledKeywordError(unmodelled, "the subschema given");

  const branches = schema["anyOf"];
  if (Array.isArray(branches) && !branches.some((b) => accepts(b as JsonSchema, value))) {
    return false;
  }

  const type = schema["type"];
  if (typeof type === "string" && !matchesType(value, type)) return false;

  const allowed = schema["enum"];
  if (Array.isArray(allowed) && !allowed.includes(value)) return false;

  if (Array.isArray(value)) {
    const items = schema["items"];
    if (items !== undefined && !value.every((v) => accepts(items as JsonSchema, v))) return false;
    return true;
  }

  if (typeof value === "object" && value !== null) {
    return acceptsObject(schema, value as Record<string, unknown>);
  }

  return true;
}

/** The published document itself — parsed from the built bytes, not rebuilt from zod. */
const publishedSchema = JSON.parse(buildSchema()) as JsonSchema;

function isSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every subschema in the document, each paired with the path it sits at.
 *
 * The descent is by SCHEMA-VALUED POSITION, and only those: `properties`' values, `items`,
 * `additionalProperties` and `propertyNames` when they are objects, and each `anyOf` branch.
 * `enum`, `required` and `default` hold DATA, not schemas, and are deliberately not entered —
 * walking into an `enum` member would report a spec author's string as an unmodelled keyword.
 */
function allSubschemas(schema: JsonSchema, where: string): Array<readonly [string, JsonSchema]> {
  const found: Array<readonly [string, JsonSchema]> = [[where, schema]];
  const descend = (child: unknown, at: string): void => {
    if (isSchemaObject(child)) found.push(...allSubschemas(child, at));
  };

  const properties = schema["properties"];
  if (isSchemaObject(properties)) {
    for (const [key, sub] of Object.entries(properties)) {
      descend(sub, `${where}.properties.${key}`);
    }
  }
  descend(schema["items"], `${where}.items`);
  descend(schema["additionalProperties"], `${where}.additionalProperties`);
  descend(schema["propertyNames"], `${where}.propertyNames`);
  const branches = schema["anyOf"];
  if (Array.isArray(branches)) {
    for (const [i, branch] of branches.entries()) descend(branch, `${where}.anyOf[${i}]`);
  }
  return found;
}

const ALL_SUBSCHEMAS = allSubschemas(publishedSchema, "(root)");

/**
 * Run at module load, over the whole document, so a keyword this checker does not model fails
 * the FILE rather than waiting for a test value to happen to descend onto it. See the header.
 */
function assertNoUnmodelledKeyword(subschemas: readonly (readonly [string, JsonSchema])[]): void {
  for (const [where, sub] of subschemas) {
    const unmodelled = unmodelledKeywords(sub)[0];
    if (unmodelled !== undefined) throw unmodelledKeywordError(unmodelled, where);
  }
}

assertNoUnmodelledKeyword(ALL_SUBSCHEMAS);

function schemaWouldAccept(spec: unknown): boolean {
  return accepts(publishedSchema, spec);
}

/**
 * Walk into the built document by key. It throws on a path that is not there rather than
 * returning `undefined`, so a test asserting on a subschema fails as "this schema no longer has
 * that shape" instead of silently comparing `undefined` to `undefined`.
 */
function subSchema(schema: JsonSchema, ...keys: readonly string[]): JsonSchema {
  let cur = schema;
  for (const key of keys) {
    const next = cur[key];
    if (typeof next !== "object" || next === null) {
      throw new Error(`no subschema at ${keys.join(".")} — stopped at ${JSON.stringify(key)}`);
    }
    cur = next as JsonSchema;
  }
  return cur;
}

/* ------------------------------------------------------------------------------------------ */

/** A spec `parseSpec` accepts unchanged. Each violation below is this, with one thing wrong. */
const validSpec = {
  name: "acme",
  displayName: "Acme",
  description: "Read data out of Acme.",
  serviceLabel: "Acme",
  env: [{ vars: ["ACME_TOKEN"], local: "acmeToken", auth: "bearer", required: true }],
  fetchHelper: { local: "acmeGet", base: "https://api.acme.test" },
  tools: [{ name: "acme_list_items", description: "List items.", path: "/items" }],
};

/** Deep-copy the base spec, then let a case break exactly one thing in it. */
function specWith(mutate: (spec: JsonSchema) => void): JsonSchema {
  const copy = JSON.parse(JSON.stringify(validSpec)) as JsonSchema;
  mutate(copy);
  return copy;
}

/** The one tool of a copied spec, and its fetch helper, as plain objects a case can poke at. */
function firstTool(spec: JsonSchema): JsonSchema {
  return (spec["tools"] as JsonSchema[])[0]!;
}

function fetchHelperOf(spec: JsonSchema): JsonSchema {
  return spec["fetchHelper"] as JsonSchema;
}

/**
 * Two refinements, chosen because they are different KINDS of rule and neither has any JSON
 * Schema expression: one is cross-field (a value's legality depends on a sibling), the other is
 * content-sensitive (a string is a string, and this one would become code).
 *
 * The second is not hypothetical. `fetchHelper.base` is spliced RAW into the generated fetch
 * helper's template literal, so an interpolation no emitter resolves is emitted as an expression
 * and evaluated on every request — in a package that compiles, lints and typechecks clean. An
 * editor holding only the published schema calls that base valid.
 */
const FALLS_THROUGH_THE_GAP: readonly (readonly [string, JsonSchema])[] = [
  [
    'an argument with "default" and no "optional": true',
    specWith((s) => {
      firstTool(s)["args"] = { limit: { type: "number", default: 10 } };
    }),
  ],
  [
    "a fetchHelper.base carrying a self-contained interpolation",
    specWith((s) => {
      fetchHelperOf(s)["base"] = "https://api.acme.test/${(() => Date.now())()}";
    }),
  ],
];

describe("the checked-in schema document", () => {
  it("is byte-identical to what the generator produces, so the file cannot drift", () => {
    expect(readFileSync(SCHEMA_PATH, "utf8")).toBe(buildSchema());
  });

  it("states its own limitation, so the file alone is enough to learn about the gap", () => {
    const doc = publishedSchema as { description?: string; $id?: string; title?: string };
    expect(doc.description).toContain(SCHEMA_LIMITATION);
    expect(doc.$id).toBe(SCHEMA_ID);
    expect(doc.title).toBe("ConnectorSpec");
  });

  it("describes the INPUT shape, so an author's file is what it validates", () => {
    // `{ io: "input" }` vs `{ unrepresentable: "any" }`: in the input document, `impl` is the
    // four-value union a spec may WRITE. In the output document it collapses to `{}` — measured,
    // not inferred: the `.transform(v => v === "get" ? "rest" : v)` is unrepresentable, so
    // `unrepresentable: "any"` erases the ENUM ENTIRELY rather than narrowing it. That document
    // therefore rejects NOTHING for `impl`, and the completion list a user would most want is the
    // one thing missing from it. The cost is completion, not validation.
    const impl = subSchema(publishedSchema, "properties", "tools", "items", "properties", "impl");
    expect(impl["enum"]).toEqual(["rest", "get", "stub", "search"]);

    // And the other half of the same difference: the OUTPUT document lists every `.default()`
    // field as required, so an editor holding it would flag all 22 fixtures/*.spec.json. The
    // input document requires only what a spec file must actually write.
    expect(publishedSchema["required"]).toEqual([
      "name",
      "displayName",
      "description",
      "serviceLabel",
      "fetchHelper",
    ]);
  });

  it("is reachable from npm, and regenerable by a named script", () => {
    // A `files` array is a claim about a tarball and this only pins the claim — `npm pack
    // --dry-run` is the evidence, and it is what was actually run before this landed.
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      files: string[];
      scripts: Record<string, string>;
    };
    expect(pkg.files).toContain("schema");
    expect(pkg.scripts["schema"]).toBe("bun scripts/build-schema.ts");
  });

  it("is visible to git, which .gitignore's catch-all had to be told explicitly", () => {
    // Found on the way to the first commit, and worth a test because everything else stayed
    // green through it. `.gitignore` ignores every top-level directory (`/*/`) and re-admits the
    // ones this repo owns by name, so a brand-new `schema/` is ignored by default: the file
    // would never have been committed, and — the quiet part — test/source-hygiene.test.ts sweeps
    // with `--exclude-standard`, so an ignored schema/ is simply absent from the bytes it
    // inspects. A directory this repo publishes must be one git can see.
    const listed = Bun.spawnSync(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard", "schema"],
      { cwd: repoRoot },
    );
    expect(listed.exitCode).toBe(0);
    expect(
      listed.stdout
        .toString()
        .split("\n")
        .map((l) => l.trim()),
    ).toContain("schema/connector-spec.schema.json");
  });

  it("cannot be referenced from inside a spec file, which is why README says to map the glob", () => {
    // The obvious way to wire a JSON Schema up — a "$schema" key in the document itself — is the
    // one way that does not work here: ConnectorSpecSchema is a z.strictObject, so the key that
    // made the editor happy is the key that makes the CLI refuse the file. README states this;
    // this is what keeps the statement true if the schema ever stops being strict.
    expect(() => parseSpec({ ...validSpec, $schema: SCHEMA_ID })).toThrow(
      'Unrecognized key: "$schema"',
    );
  });

  it("is documented in README.md in the same words, alongside the URL it is served from", () => {
    // Not a style rule. A reader who learns the schema exists and not that it is incomplete has
    // been handed the false green; the two facts have to travel together, so they are asserted
    // together.
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    expect(readme).toContain(SCHEMA_LIMITATION);
    expect(readme).toContain(SCHEMA_ID);
  });
});

describe("the gap between the published schema and the generator", () => {
  it("starts from a spec parseSpec accepts, so each case below breaks exactly one thing", () => {
    expect(() => parseSpec(validSpec)).not.toThrow();
    expect(schemaWouldAccept(validSpec)).toBe(true);
  });

  for (const [what, spec] of FALLS_THROUGH_THE_GAP) {
    it(`accepts ${what}, which parseSpec rejects`, () => {
      expect(() => parseSpec(spec)).toThrow();
      expect(schemaWouldAccept(spec)).toBe(true);
    });
  }

  it("accepts an env local named `token`, which validateSpec — not parseSpec — rejects", () => {
    // README names three specs that are green in an editor and refused by the CLI; the table
    // above pins two. This is the third, and it cannot join them: every case there asserts
    // `parseSpec` itself throws, and this one gets PAST `parseSpec` entirely.
    //
    // Which is why it is the one most worth a test. RESERVED_IDENTIFIERS lives in
    // src/validate.ts and is checked by `validateSpec`, a pass of its own — the distinction the
    // schema's `description` deviates from the brief's wording to draw, and the gap here is
    // therefore wider than "the published schema is more permissive than parseSpec": it is more
    // permissive than the whole acceptance path the CLI runs.
    const spec = specWith((s) => {
      (s["env"] as JsonSchema[])[0]!["local"] = "token";
    });
    expect(() => parseSpec(spec)).not.toThrow();
    expect(() => validateSpec(parseSpec(spec))).toThrow(/Identifier collision: "token"/);
    expect(schemaWouldAccept(spec)).toBe(true);
  });
});

describe("the structural checker the gap tests are built on", () => {
  // Without these the gap tests above are unfalsifiable: a `schemaWouldAccept` that returned
  // `true` unconditionally would pass every one of them while inspecting nothing.
  it("rejects a spec missing a required key", () => {
    const { displayName: _dropped, ...withoutDisplayName } = validSpec;
    expect(schemaWouldAccept(withoutDisplayName)).toBe(false);
  });

  it("rejects an unknown key, since the schema is additionalProperties: false", () => {
    const spec = specWith((s) => {
      s["misspelled"] = true;
    });
    expect(schemaWouldAccept(spec)).toBe(false);
  });

  it("rejects a value of the wrong type", () => {
    const spec = specWith((s) => {
      s["syncInterval"] = "300";
    });
    expect(schemaWouldAccept(spec)).toBe(false);
  });

  it("rejects a value outside an enum, nested inside an array item", () => {
    const atRoot = specWith((s) => {
      s["style"] = "artisanal";
    });
    const inATool = specWith((s) => {
      firstTool(s)["effect"] = "annihilate";
    });
    expect(schemaWouldAccept(atRoot)).toBe(false);
    expect(schemaWouldAccept(inATool)).toBe(false);
  });

  it("rejects a value the wrong type deep inside a record of records", () => {
    const spec = specWith((s) => {
      firstTool(s)["args"] = { limit: { type: "number", int: "yes" } };
    });
    expect(schemaWouldAccept(spec)).toBe(false);
  });

  it("throws on a keyword it does not model, rather than passing the value", () => {
    expect(() => accepts({ oneOf: [] }, {})).toThrow("unmodelled keyword");
    expect(() => accepts({ type: "sausage" }, "x")).toThrow('unmodelled "type"');
  });

  it("sweeps the whole published document, not only the parts a test value descends into", () => {
    // `assertNoUnmodelledKeyword` runs at module load and throws, so it cannot itself be a test —
    // this is what stops the WALK it runs over from going vacuous. A `allSubschemas` that
    // descended nowhere would return one entry, sweep the root object, and be exactly as blind as
    // the per-call guard it replaced.
    expect(ALL_SUBSCHEMAS.length).toBeGreaterThan(50);

    // The two the per-call guard could not reach, named because they are the ones measured: with
    // the guard inside `accepts`, injecting `oneOf: []` into either left all sixteen tests green,
    // since `validSpec` declares no `filesystem` and its one tool declares no `filter`, so no
    // value here ever descends onto those subschemas.
    const visited = new Set(ALL_SUBSCHEMAS.map(([where]) => where));
    expect(visited).toContain("(root).properties.filesystem.properties.read");
    expect(visited).toContain("(root).properties.tools.items.properties.filter");
  });
});
