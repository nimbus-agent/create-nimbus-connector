import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAll, initFormatter } from "../src/format.ts";
import { EnvSchema, parseSpec, ToolSchema } from "../src/spec.ts";

/**
 * Which words an identifier field may hold, decided by the parser the generator itself runs.
 *
 * `identifierField()`'s regex matched every reserved word there is, so `bindings: ["class"]`
 * emitted `const class = process.env["ZZ_V"]?.trim();` — a parse error against the generator's
 * own output, reported as a Biome failure rather than as a spec error. The list of words that
 * closed it is the kind of artefact this branch keeps having to correct, so it is not restated
 * here: this file DERIVES the answer and compares.
 *
 * **The oracle is Biome**, reached through `formatAll` — the same call `src/cli.ts` makes on
 * every generated file. "The word breaks the emitted output" is therefore literally the failure
 * the fix exists to prevent, not a proxy for it.
 *
 * **The universe is extracted, not typed.** A hand-written candidate list is how `static`,
 * `package`, `eval` and `arguments` get missed. The two lists below are read out of installed
 * packages at test time, and `it("extracts a universe large enough to be worth searching")`
 * fails loudly if a version bump ever moves them — the safe direction, since a shrunken universe
 * would otherwise make the sweep silently weaker.
 */

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** Every `createKeyword("x")` / `createKeywordLike("x")` in @babel/parser's compiled tokenizer. */
function babelParserKeywords(): string[] {
  const src = readFileSync(
    join(REPO_ROOT, "node_modules", "@babel", "parser", "lib", "index.js"),
    "utf8",
  );
  return [...src.matchAll(/createKeyword(?:Like)?\("([A-Za-z_$]+)"/g)].map((m) => m[1]!);
}

/**
 * The `keyword` / `strict` / `strictBind` arrays in @babel/helper-validator-identifier.
 *
 * Not redundant with the tokenizer above, and the difference is the point: `package`, `private`,
 * `protected`, `public`, `eval` and `arguments` appear in NEITHER of the parser's two keyword
 * tables — they are ordinary identifiers to the tokenizer and reserved only by strict mode, which
 * every emitted module is in. Six words a parser-only universe would have missed.
 */
function babelReservedWordTables(): string[] {
  const src = readFileSync(
    join(REPO_ROOT, "node_modules", "@babel", "helper-validator-identifier", "lib", "index.js"),
    "utf8",
  );
  return [...src.matchAll(/(?:keyword|strict|strictBind): \[([^\]]*)\]/g)]
    .flatMap((m) => m[1]!.split(","))
    .map((w) => w.trim().replaceAll('"', ""))
    .filter((w) => w.length > 0);
}

/**
 * TypeScript spellings that live in the type namespace or are contextual, added so the sweep has
 * something to over-reject. Without them it could only ever catch a MISSING word; with them it
 * also catches a rule that has grown too wide, which is the cost the derivation exists to avoid.
 */
const CONTROLS = [
  "any",
  "unknown",
  "never",
  "number",
  "string",
  "boolean",
  "object",
  "symbol",
  "bigint",
  "undefined",
  "accessor",
  "out",
  "override",
  "abstract",
  "satisfies",
  "infer",
  "keyof",
  "asserts",
  "NaN",
  "Infinity",
];

const UNIVERSE = [
  ...new Set([...babelParserKeywords(), ...babelReservedWordTables(), ...CONTROLS]),
].sort();

/**
 * The three declaration positions the emitters put an identifier field into: a `const`
 * (`readLines`, `renderHoists`, `baseConst`, `rows`), a `function` (every env accessor, the fetch
 * helper) and an `export function` (a search filter's export). A word is broken if any of them
 * fails to parse.
 *
 * `export {}` is on the const and function snippets deliberately — it makes the file a MODULE, so
 * Biome applies strict mode. Without it `let`, `static`, `implements`, `eval` and `arguments`
 * parse fine and the sweep would report five words as legal that are not.
 */
function declarationsParse(word: string): boolean {
  const snippets = [
    `const ${word} = 1;\nexport {};\n`,
    `function ${word}(): void {}\nexport {};\n`,
    `export function ${word}(): void {}\n`,
  ];
  for (const content of snippets) {
    try {
      formatAll([{ path: ["src", "server.ts"], content }]);
    } catch {
      return false;
    }
  }
  return true;
}

/** Whether the shipped rule lets the word through, asked at a real field of a real schema. */
function acceptedAsEnvLocal(word: string): boolean {
  return EnvSchema.safeParse({ vars: ["ZZ_V"], local: word, required: true }).success;
}

function acceptedAsArgKey(word: string): boolean {
  return ToolSchema.safeParse({
    name: "zz_get",
    description: "d.",
    path: "/v1/things",
    args: { [word]: { type: "string" } },
  }).success;
}

beforeAll(async () => {
  await initFormatter();
});

describe("the universe the sweep searches", () => {
  it("extracts a universe large enough to be worth searching", () => {
    // Floors, not exact counts: a version bump may legitimately add a contextual keyword, and
    // that must not fail. Losing the extraction entirely must.
    expect(babelParserKeywords().length).toBeGreaterThanOrEqual(70);
    expect(babelReservedWordTables().length).toBeGreaterThanOrEqual(40);
    expect(UNIVERSE.length).toBeGreaterThanOrEqual(90);
  });

  it("contains the six words only the strict-mode tables carry", () => {
    // The claim the second extractor's docstring makes, checked rather than asserted in prose.
    const fromParser = new Set(babelParserKeywords());
    for (const w of ["package", "private", "protected", "public", "eval", "arguments"]) {
      expect(fromParser.has(w)).toBe(false);
      expect(UNIVERSE).toContain(w);
    }
  });

  it("contains words on both sides of the answer", () => {
    const broken = UNIVERSE.filter((w) => !declarationsParse(w));
    expect(broken.length).toBeGreaterThan(0);
    expect(broken.length).toBeLessThan(UNIVERSE.length);
  });
});

/**
 * A rule the user cannot read is a rule the user cannot follow.
 *
 * `tools[].args` is the schema's only record with a key rule, and zod 4 buries a key failure
 * inside an `invalid_key` issue whose own message is "Invalid key in record". Both of the
 * assertions below failed before `issueMessage` (src/spec.ts) unwrapped it — including the
 * `data-items` one, which has nothing to do with reserved words and has been silent since the
 * field was introduced.
 */
describe("a rejected argument key reports the rule that rejected it", () => {
  const spec = (argKey: string): unknown => ({
    name: "zzprobe",
    displayName: "Zz Probe",
    description: "Probe connector.",
    serviceLabel: "ZzProbe",
    style: "hand-rolled",
    env: [{ vars: ["ZZ_TOKEN"], local: "authHeaders", auth: "bearer" }],
    fetchHelper: { local: "zzGet", base: "https://api.example.com", headers: "authHeaders" },
    tools: [
      {
        name: "zzprobe_get",
        description: "Get.",
        path: "/v1/things",
        args: { [argKey]: { type: "string" } },
      },
    ],
  });

  it("names the reserved word, and what carries the wire spelling instead", () => {
    expect(() => parseSpec(spec("class"))).toThrow(/"class" is a JavaScript reserved word/);
    expect(() => parseSpec(spec("class"))).toThrow(/"body", which maps an argument key/);
    expect(() => parseSpec(spec("class"))).not.toThrow(/Invalid key in record/);
  });

  it("states the shape rule for a key that is not identifier-shaped at all", () => {
    expect(() => parseSpec(spec("data-items"))).toThrow(
      /argument name must be a valid JS identifier/,
    );
  });
});

describe("an identifier field accepts a word exactly when a declaration of it parses", () => {
  for (const word of UNIVERSE) {
    it(`agrees with Biome on ${JSON.stringify(word)}`, () => {
      const parses = declarationsParse(word);
      expect(acceptedAsEnvLocal(word)).toBe(parses);
      // The same rule, and the same answer, at the one field that used to carry its own copy of
      // the regex. An argument key reaches a `const` only when the argument is hoisted; the rule
      // is flat regardless — see ToolSchema's `args`.
      expect(acceptedAsArgKey(word)).toBe(parses);
    });
  }
});
