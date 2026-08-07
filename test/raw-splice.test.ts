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

/** Every emitted file a spec produces, for both targets, plus the Gateway wiring when it has one. */
function everyEmittedFile(spec: ConnectorSpec): GeneratedFile[] {
  const out: GeneratedFile[] = [];
  for (const target of ["monorepo", "standalone"] as const) {
    out.push(...generate(spec, { target }));
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
        let files: GeneratedFile[];
        try {
          files = everyEmittedFile(spec);
        } catch {
          continue; // refused by validateSpec, or no emitter path for this shape
        }
        for (const file of files) {
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
    // floors, not measurements: the sweep runs thousands of probes over the 22 fixtures.
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
              continue; // refused before emission, which is the intended outcome
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
describe("what the 22 fixtures put in a guarded field", () => {
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

  it("opens an interpolation only in the two fields whose disposition takes one", () => {
    // Not "how many occurrences" but "how many fixtures", which is the claim the docstring makes.
    const byField = new Map<string, Set<string>>();
    for (const { field, value, file } of guardedValues()) {
      if (!value.includes("${")) continue;
      byField.set(field, (byField.get(field) ?? new Set<string>()).add(file));
    }
    const counts = Object.fromEntries([...byField].map(([f, s]) => [f, s.size]));
    // `undefined` is the disposition of the other four carriers, and none of them may appear.
    expect(counts).toEqual({ "fetchHelper.base": 7, "tools[].path": 19 });
  });
});
