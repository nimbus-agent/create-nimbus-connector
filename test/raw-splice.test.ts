import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "../src/emit/index.ts";
import { emitWiring } from "../src/emit/wiring.ts";
import { type ConnectorSpec, parseSpec } from "../src/spec.ts";
import type { GeneratedFile } from "../src/types.ts";

/**
 * The raw-splice census: which spec strings reach generated TypeScript UNQUOTED, derived from
 * the emitters rather than read off a list.
 *
 * This file exists because the list was wrong. `RAW_SPLICE_TERMINATORS`'s docstring opened
 * "Two fields are spliced with no quoting or escaping" while six others were, one of them
 * (`env[].prefix`) carrying an executable IIFE into the Authorization header of every request.
 * The count was written by the fix that introduced the guard, and it was checked only against
 * the two fields that motivated the fix. A test that restated that list would have the same
 * property and would be worth the same nothing, so this one does not restate it: it PROBES the
 * emitters and reports what they do.
 *
 * The probe rests on one property of the quoting schemes this repository uses. Every quoted
 * splice site goes through `JSON.stringify` (or, for `manifest`/`package.json`, whole-document
 * JSON serialisation), and `JSON.stringify` escapes a double quote. So a marker containing one
 * survives VERBATIM only where nothing quoted it — a template literal, a comment, an identifier
 * position, or bare code. Verbatim survival is the definition of "raw" used throughout this file.
 *
 * A field guarded by an identifier rule never reaches emission with the marker in it at all
 * (`parseSpec` refuses it), so it is correctly absent from the census. That is not a blind spot:
 * such a field cannot carry arbitrary characters, which is the hazard being counted.
 */
const RAW_MARKER = 'Zq"Zq';

/**
 * The sequences a raw-spliced string must not be able to deliver, and what each one does when it
 * arrives. Mirrors `RAW_SPLICE_TERMINATORS` in src/spec.ts by INTENT, transcribed independently
 * — the same discipline `test/source-hygiene.test.ts`'s `MUST_BE_CAUGHT` applies, and for the
 * same reason: a loop over the schema's own list would confirm only that the schema agrees with
 * itself.
 */
const HAZARDS: readonly (readonly [string, string])[] = [
  ["a backtick, which ends a template literal", "Zq`Zq"],
  ["a block-comment terminator, which ends a docstring", "Zq*/Zq"],
  ["an interpolation opener, whose expression is evaluated", "Zq${Zq"],
  ["a backslash, which escapes the character after it", "Zq\\Zq"],
];

const FIXTURES = join(import.meta.dir, "..", "fixtures");

type Leaf = { readonly path: readonly (string | number)[]; readonly value: string };

/** Every string leaf of a parsed spec document, by its JSON path. */
function stringLeaves(node: unknown, path: (string | number)[], out: Leaf[]): void {
  if (typeof node === "string") {
    out.push({ path: [...path], value: node });
    return;
  }
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) stringLeaves(v, [...path, i], out);
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node)) stringLeaves(v, [...path, k], out);
  }
}

function withValueAt(doc: unknown, path: readonly (string | number)[], value: string): unknown {
  const copy = JSON.parse(JSON.stringify(doc)) as Record<string | number, unknown>;
  let cur = copy;
  for (const seg of path.slice(0, -1)) cur = cur[seg] as Record<string | number, unknown>;
  cur[path.at(-1)!] = value;
  return copy;
}

/**
 * A concrete JSON path as the FIELD it names — array indices collapse to `[]`, so the three
 * `env` entries of one fixture and the twenty-two fixtures' worth of them all report as
 * `env[].prefix`. The census is about fields; positions are what the sweep enumerates.
 */
function fieldOf(path: readonly (string | number)[]): string {
  return path
    .map((s) => (typeof s === "number" ? "[]" : s))
    .join(".")
    .replaceAll(".[]", "[]");
}

/**
 * An emitted file as the census names it. Gateway wiring files are named after the connector
 * (`bitrise-mapping.ts`), which would make the evidence below a list of twenty-two near-identical
 * strings instead of a construct.
 */
function fileKind(path: readonly string[]): string {
  const joined = path.join("/");
  return joined.replace(/^[a-z0-9-]+-(sync|mapping)\.ts$/, "*-$1.ts");
}

const specDocuments = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".spec.json"))
  .map((f) => ({ file: f, doc: JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) as unknown }));

/**
 * Every emitted file a spec produces, for both targets, plus the Gateway wiring when it has one.
 *
 * Each emission is caught SEPARATELY, and never rethrown. The call sites used to wrap the whole
 * function in one `try { … } catch { continue }`, so a spec the standalone target refused threw
 * away the monorepo's files too — the census would then have reported "this field is not a
 * carrier" on evidence it had discarded. It changes no answer today (a per-target run finds the
 * same carrier set), which is the point: it is the failure mode, not a failure.
 *
 * A probe every branch refuses returns an empty list rather than throwing, so the caller has no
 * catch left to write and nothing to skip.
 */
function everyEmittedFile(spec: ConnectorSpec): GeneratedFile[] {
  const out: GeneratedFile[] = [];
  for (const target of ["monorepo", "standalone"] as const) {
    try {
      out.push(...generate(spec, { target }));
    } catch {
      // validateSpec refused it, or this target has no emitter path for this shape. The other
      // target's files stand on their own.
    }
  }
  try {
    out.push(...emitWiring(spec));
  } catch {
    // No tool name ends in "_list"; --gateway-wiring is not offered for this spec.
  }
  return out;
}

type Census = {
  /** field -> the emitted .ts files it reaches verbatim. */
  readonly carriers: Map<string, Set<string>>;
  /** How many (leaf, placement) probes the sweep actually ran. */
  readonly probes: number;
  /** How many emitted files the sweep actually inspected. */
  readonly inspected: number;
};

/**
 * Splice `RAW_MARKER` into every string leaf of every fixture, twice — once at each end.
 *
 * Both placements, because one of them is load-bearing: `emitWiring` selects the tool whose name
 * ends in `_list`, so a marker APPENDED to that name takes the spec out of the branch it is
 * meant to probe. Prepending keeps the suffix intact.
 */
function census(): Census {
  const carriers = new Map<string, Set<string>>();
  let probes = 0;
  let inspected = 0;

  for (const { doc } of specDocuments) {
    const leaves: Leaf[] = [];
    stringLeaves(doc, [], leaves);

    for (const leaf of leaves) {
      for (const probe of [`${RAW_MARKER}${leaf.value}`, `${leaf.value}${RAW_MARKER}`]) {
        probes += 1;
        let spec: ConnectorSpec;
        try {
          spec = parseSpec(withValueAt(doc, leaf.path, probe));
        } catch {
          continue; // refused at the schema: the field cannot carry arbitrary characters
        }
        for (const file of everyEmittedFile(spec)) {
          inspected += 1;
          if (!file.path.at(-1)!.endsWith(".ts")) continue;
          if (!file.content.includes(RAW_MARKER)) continue;
          const field = fieldOf(leaf.path);
          const seen = carriers.get(field) ?? new Set<string>();
          seen.add(fileKind(file.path));
          carriers.set(field, seen);
        }
      }
    }
  }
  return { carriers, probes, inspected };
}

const CENSUS = census();

/**
 * The census's expected answer: every field the emitters splice into generated TypeScript
 * unquoted, and the emitted files each one reaches.
 *
 * This is the thing under test, not the source of the answer. `CENSUS` is computed from the real
 * emitters; if an emitter change adds a splice site, or moves one to a new file, the comparison
 * below fails and the new site has to be looked at and guarded before this table is updated.
 * That is the direction the old docstring's "Two" could not fail in.
 */
const EXPECTED_CARRIERS: Readonly<Record<string, readonly string[]>> = {
  // The fetch helper's URL template, in all three helper renderers.
  "fetchHelper.base": ["src/server.ts"],
  // Two error-message templates, the token-exchange message, and a Gateway block comment.
  serviceLabel: ["*-mapping.ts", "*-sync.ts", "src/server.ts"],
  // wrapped()'s value template, and the username argument to encodeBasicAuthHeader.
  "env[].prefix": ["src/server.ts"],
  "env[].suffix": ["src/server.ts"],
  // renderMapping's docstring. Quoted everywhere else it is emitted.
  "tools[].name": ["*-mapping.ts"],
  // renderPath's literal segments. It escapes a backtick and a backslash itself; the schema
  // refuses all three terminators anyway, per RAW_SPLICE_TERMINATORS's own stated rule.
  "tools[].path": ["src/server.ts"],
  // A guard's path goes through the same renderPath as tools[].path above, and zzcond's own
  // guard is dynamic (`/apps/${arg.appId|enc}`) rather than fully static — a static guard path
  // renders JSON.stringify-quoted (see renderPath's own !dynamic branch) and would never reach
  // this table at all, which is exactly why the fixture was grown to interpolate an arg.
  "tools[].pathWhen[].path": ["src/server.ts"],
};

describe("the raw-splice census", () => {
  it("finds exactly the fields the emitters are known to splice unquoted", () => {
    const found = Object.fromEntries(
      [...CENSUS.carriers].map(([field, files]) => [field, [...files].sort()]),
    );
    expect(found).toEqual(
      Object.fromEntries(Object.entries(EXPECTED_CARRIERS).map(([k, v]) => [k, [...v].sort()])),
    );
  });

  it("is non-vacuous: the sweep ran real probes and inspected real emitted files", () => {
    // Without this, a `stringLeaves` that walked nothing, or an `everyEmittedFile` that returned
    // nothing, would report an empty census — and an empty census compared against an empty
    // expectation is the exact false green this whole file exists to refuse. The numbers are
    // floors, not measurements: the sweep runs thousands of probes over the 24 fixtures.
    expect(specDocuments.length).toBeGreaterThan(20);
    expect(CENSUS.probes).toBeGreaterThan(1000);
    expect(CENSUS.inspected).toBeGreaterThan(1000);
  });

  it("proves the marker distinguishes raw from quoted, rather than matching everything", () => {
    // The probe's whole premise. `description` is spliced through JSON.stringify at every one of
    // its sites, so the marker must come back ESCAPED — if it came back verbatim the census would
    // be reporting every string field and its agreement with EXPECTED_CARRIERS would be luck.
    const doc = specDocuments.find((s) => s.file === "zzreadonly.spec.json")!.doc as {
      tools: { description: string }[];
    };
    const poisoned = withValueAt(doc, ["tools", 0, "description"], RAW_MARKER);
    const server = generate(parseSpec(poisoned)).find(
      (f) => f.path.join("/") === "src/server.ts",
    )!.content;
    expect(server).toContain('Zq\\"Zq');
    expect(server).not.toContain(RAW_MARKER);
  });
});

describe("every carrier refuses every sequence that could break out of its construct", () => {
  /**
   * The guard, asserted over the DERIVED carrier set rather than a written one — so a field that
   * becomes a carrier is held to this rule the moment the census notices it, without anyone
   * remembering to add it here.
   *
   * "Refuses" is deliberately the weaker of two claims: what has to hold is that the sequence
   * never arrives in emitted TypeScript, whether because `parseSpec` rejected the spec, because
   * `validateSpec` did, or because the emitter escaped it at the splice site (`renderPath` does
   * exactly that for a backtick and a backslash). Demanding a schema rejection specifically would
   * declare the emitter's own escaping a failure.
   */
  for (const [name, hazard] of HAZARDS) {
    it(`never delivers ${name}`, () => {
      const delivered: string[] = [];
      for (const { file, doc } of specDocuments) {
        const leaves: Leaf[] = [];
        stringLeaves(doc, [], leaves);
        for (const leaf of leaves) {
          if (!Object.hasOwn(EXPECTED_CARRIERS, fieldOf(leaf.path))) continue;
          for (const probe of [`${hazard}${leaf.value}`, `${leaf.value}${hazard}`]) {
            let files: GeneratedFile[];
            try {
              files = everyEmittedFile(parseSpec(withValueAt(doc, leaf.path, probe)));
            } catch {
              continue; // parseSpec refused it, which is the intended outcome
            }
            for (const f of files) {
              if (!f.path.at(-1)!.endsWith(".ts")) continue;
              if (f.content.includes(hazard)) {
                delivered.push(`${file} ${fieldOf(leaf.path)} -> ${fileKind(f.path)}`);
              }
            }
          }
        }
      }
      expect([...new Set(delivered)]).toEqual([]);
    });
  }

  it("reaches every carrier, so no hazard passes for want of a spec that sets the field", () => {
    // The loop above skips a carrier no fixture happens to declare, silently. This is what makes
    // "never delivers" mean "was tried on all six" rather than "was tried on whichever four the
    // fixtures set". It is the same guard shape source-hygiene needed: count the inspection, not
    // the listing.
    const reached = new Set<string>();
    for (const { doc } of specDocuments) {
      const leaves: Leaf[] = [];
      stringLeaves(doc, [], leaves);
      for (const leaf of leaves) {
        if (Object.hasOwn(EXPECTED_CARRIERS, fieldOf(leaf.path))) reached.add(fieldOf(leaf.path));
      }
    }
    expect([...reached].sort()).toEqual(Object.keys(EXPECTED_CARRIERS).sort());
  });
});

/**
 * What the fixtures actually put in a guarded field — the measurement `rawSplicedString`'s
 * docstring states, held here so it cannot go stale silently.
 *
 * It is a live number about a directory in THIS repository, which is the case CLAUDE.md's
 * no-numbers-in-prose rule leaves room for: a corpus count cannot be re-run in CI, this can.
 * The prose said `${` "appears only in fetchHelper.base" while it was in a `tools[].path` in
 * nineteen of the twenty-two fixtures — the second stale count inside one docstring that had
 * just been rewritten to remove the first.
 */
describe("what the 24 fixtures put in a guarded field", () => {
  function guardedValues(): { field: string; value: string; file: string }[] {
    const out: { field: string; value: string; file: string }[] = [];
    for (const { file, doc } of specDocuments) {
      const leaves: Leaf[] = [];
      stringLeaves(doc, [], leaves);
      for (const leaf of leaves) {
        const field = fieldOf(leaf.path);
        if (Object.hasOwn(EXPECTED_CARRIERS, field)) out.push({ field, value: leaf.value, file });
      }
    }
    return out;
  }

  it("carries no terminator in any of them", () => {
    const hits = guardedValues().filter(({ value }) =>
      ["`", "*/", "\\"].some((t) => value.includes(t)),
    );
    expect(hits).toEqual([]);
  });

  it("opens an interpolation only in the three fields whose disposition takes one", () => {
    // Not "how many occurrences" but "how many fixtures", which is the claim the docstring makes.
    const byField = new Map<string, Set<string>>();
    for (const { field, value, file } of guardedValues()) {
      if (!value.includes("${")) continue;
      byField.set(field, (byField.get(field) ?? new Set<string>()).add(file));
    }
    const counts = Object.fromEntries([...byField].map(([f, s]) => [f, s.size]));
    // `undefined` is the disposition of the other four carriers, and none of them may appear.
    // zzcond's own guard is the ONLY dynamic pathWhen path in the corpus of fixtures — it exists
    // to make this field a carrier at all (see EXPECTED_CARRIERS's own comment on it).
    expect(counts).toEqual({
      "fetchHelper.base": 7,
      "tools[].path": 21,
      "tools[].pathWhen[].path": 1,
    });
  });
});

/* ------------------------------------------------------------------------------------------ *
 * What bounds the census: the fields the fixtures happen to set.
 *
 * The sweep above splices its marker into every string leaf of every fixture DOCUMENT, so a
 * string-valued spec field no fixture writes is never probed at all — and "finds exactly the
 * fields the emitters are known to splice unquoted" reads exactly the same whether that field is
 * safe or is a carrier nobody looked at. Three such fields exist today (`id`,
 * `filesystem.read[]`, `filesystem.write[]`), and nothing said so.
 *
 * Closed in two halves rather than written down: the schema's own string positions are enumerated
 * and compared against what the fixtures reach, and every position that comes up short has to
 * carry its own probe below. A new string field added to the spec language therefore fails here
 * until someone either gives it a fixture or proves it is not a carrier.
 * ------------------------------------------------------------------------------------------ */

const SCHEMA = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "schema", "connector-spec.schema.json"), "utf8"),
) as JsonSchema;

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: JsonSchema | boolean;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
};

/**
 * Every position the published schema allows a FREE string in, as a dotted path with `[]` for an
 * array index and `*` for a record key — the same shape `fieldOf` produces, so the two sets can be
 * compared directly.
 *
 * An `enum` is excluded: its value set is fixed, so it cannot carry a terminator or an
 * interpolation whatever an emitter does with it. Only the keywords the generated schema actually
 * uses are handled (`properties`, `items`, `additionalProperties`, `anyOf`, `enum`), which
 * test/schema.test.ts's drift check pins.
 */
function stringPositions(node: JsonSchema, path: string, out: Set<string>): void {
  if (node.anyOf !== undefined) {
    for (const b of node.anyOf) stringPositions(b, path, out);
    return;
  }
  if (node.type === "string") {
    if (node.enum === undefined) out.add(path);
    return;
  }
  if (node.items !== undefined) {
    stringPositions(node.items, `${path}[]`, out);
    return;
  }
  for (const [k, v] of Object.entries(node.properties ?? {})) {
    stringPositions(v, path === "" ? k : `${path}.${k}`, out);
  }
  if (typeof node.additionalProperties === "object") {
    stringPositions(node.additionalProperties, path === "" ? "*" : `${path}.*`, out);
  }
}

/** The same, for a fixture document: which schema positions its own string leaves land on. */
function positionsReached(node: JsonSchema, doc: unknown, path: string, out: Set<string>): void {
  if (node.anyOf !== undefined) {
    for (const b of node.anyOf) positionsReached(b, doc, path, out);
    return;
  }
  if (node.type === "string") {
    if (node.enum === undefined && typeof doc === "string") out.add(path);
    return;
  }
  if (node.items !== undefined) {
    if (Array.isArray(doc)) for (const v of doc) positionsReached(node.items, v, `${path}[]`, out);
    return;
  }
  if (typeof doc !== "object" || doc === null) return;
  const obj = doc as Record<string, unknown>;
  for (const [k, v] of Object.entries(node.properties ?? {})) {
    if (Object.hasOwn(obj, k)) positionsReached(v, obj[k], path === "" ? k : `${path}.${k}`, out);
  }
  if (typeof node.additionalProperties === "object") {
    for (const k of Object.keys(obj)) {
      if (Object.hasOwn(node.properties ?? {}, k)) continue;
      positionsReached(node.additionalProperties, obj[k], path === "" ? "*" : `${path}.*`, out);
    }
  }
}

/**
 * String positions no fixture writes, each paired with the probe that stands in for the fixture.
 *
 * This is not an exemption list. An entry costs a value the census can splice a marker into, and
 * the test below runs the same verbatim-survival check on it that the sweep runs on every fixture
 * leaf — so a field is here because it was PROBED and is not a carrier, not because it was
 * excused. All three reach only `nimbus.extension.json`, through the whole-document
 * `JSON.stringify` in src/emit/manifest.ts.
 */
const PROBED_WITHOUT_A_FIXTURE: Readonly<Record<string, (marker: string) => unknown>> = {
  id: (m) => ({ id: `com.nimbus.zz${m}` }),
  "filesystem.read[]": (m) => ({ filesystem: { read: [`/tmp/${m}`], write: [] } }),
  "filesystem.write[]": (m) => ({ filesystem: { read: [], write: [`/tmp/${m}`] } }),
  // The VALUE half of `env[].extraHeaders`, a record — `stringPositions` walks
  // `additionalProperties` (the value schema) but never `propertyNames` (the key's own regex),
  // so the KEY position never enters `declared` at all and needs no probe of its own. The value
  // has no character restriction and reaches `extraProps` (src/emit/server/env.ts) through
  // `JSON.stringify`, so this belongs beside `id`/`filesystem.*` rather than in the REFUSED list.
  "env[].extraHeaders.*": (m) => ({
    env: [
      {
        vars: ["ZZREADONLY_TOKEN"],
        local: "headers",
        bindings: ["t"],
        auth: "bearer",
        extraHeaders: { "X-Extra": m },
      },
    ],
  }),
};

/**
 * String positions no fixture writes, each paired with a patch that proves — by actually calling
 * `parseSpec`, not by a comment claiming it — that the field's own schema pattern refuses
 * `RAW_MARKER` before the marker can reach emission. This is `PROBED_WITHOUT_A_FIXTURE`'s mirror:
 * that loop below proves the marker SURVIVES to emission at each of its fields, this one proves
 * it never gets past `parseSpec` at each of its fields. A field belongs here rather than there
 * exactly when its patch cannot even be applied — `PROBED_WITHOUT_A_FIXTURE`'s own probe assumes
 * `parseSpec` accepts the patched value, which is false for an identifier/pattern-guarded field
 * (see the paragraph above `RAW_MARKER`'s declaration, on a field "guarded by an identifier
 * rule"). Same shape as its sibling — `Record<string, (marker: string) => unknown>` — so the two
 * mechanisms stay symmetric and a field can move between them without a reshape.
 */
const REFUSED_WITHOUT_A_FIXTURE: Readonly<Record<string, (marker: string) => unknown>> = {
  "env[].authScheme": (m) => ({
    env: [
      {
        vars: ["ZZREADONLY_TOKEN"],
        local: "headers",
        bindings: ["t"],
        auth: "bearer",
        authScheme: m,
      },
    ],
  }),
};

describe("the census's coverage of the spec language", () => {
  const declared = new Set<string>();
  stringPositions(SCHEMA, "", declared);
  const reached = new Set<string>();
  for (const { doc } of specDocuments) positionsReached(SCHEMA, doc, "", reached);

  it("reaches every free-string position the schema declares, or probes it by hand", () => {
    const unreached = [...declared].filter((p) => !reached.has(p)).sort();
    expect(unreached).toEqual(
      [...Object.keys(PROBED_WITHOUT_A_FIXTURE), ...Object.keys(REFUSED_WITHOUT_A_FIXTURE)].sort(),
    );
  });

  it("is non-vacuous: the schema walk found positions and the fixtures reached most of them", () => {
    // A `stringPositions` that returned nothing would make the comparison above trivially pass
    // once the list were emptied, and a `positionsReached` that returned everything would too.
    expect(declared.size).toBeGreaterThan(20);
    expect(reached.size).toBeGreaterThan(20);
    expect(declared.size - reached.size).toBe(
      Object.keys(PROBED_WITHOUT_A_FIXTURE).length + Object.keys(REFUSED_WITHOUT_A_FIXTURE).length,
    );
  });

  for (const [field, patch] of Object.entries(PROBED_WITHOUT_A_FIXTURE)) {
    it(`probes "${field}", which no fixture sets, and finds it is not a carrier`, () => {
      const base = specDocuments.find((s) => s.file === "zzreadonly.spec.json")!.doc as object;
      const spec = parseSpec({ ...base, ...(patch(RAW_MARKER) as object) });
      const files = everyEmittedFile(spec);
      const ts = files.filter((f) => f.path.at(-1)!.endsWith(".ts"));
      // Non-vacuity for this probe specifically: the patched value has to have reached the
      // generator at all, proven by finding the ESCAPED marker somewhere among the emitted
      // files — `id`/`filesystem.*` land it in the manifest (whole-document JSON.stringify),
      // `env[].extraHeaders.*` lands it in src/server.ts (extraProps' own JSON.stringify), and
      // "somewhere among ALL emitted files" is what lets one loop cover both without assuming
      // which file the value reaches.
      expect(files.some((f) => f.content.includes('Zq\\"Zq'))).toBe(true);
      expect(ts.filter((f) => f.content.includes(RAW_MARKER)).map((f) => f.path.join("/"))).toEqual(
        [],
      );
    });
  }

  for (const [field, patch] of Object.entries(REFUSED_WITHOUT_A_FIXTURE)) {
    it(`probes "${field}", which no fixture sets, and finds parseSpec refuses the marker`, () => {
      const base = specDocuments.find((s) => s.file === "zzreadonly.spec.json")!.doc as object;
      // Asserting merely "throws" would pass for the wrong reason too — a patch malformed in some
      // OTHER way would throw just as loudly. The path segment pins the failure to the field this
      // entry claims to probe, so a future entry patching the wrong field, or one whose field
      // turns out not to be guarded after all, fails here instead of passing by accident.
      const fieldPath = field.replace(/\[\]/g, "[0]");
      expect(() => parseSpec({ ...base, ...(patch(RAW_MARKER) as object) })).toThrow(
        new RegExp(fieldPath.replace(/[.[\]]/g, "\\$&")),
      );
    });
  }
});
