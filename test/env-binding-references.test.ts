import { describe, expect, it } from "bun:test";
import { renderEnvAccessor } from "../src/emit/server/env.ts";
import { EnvSchema, type EnvSpec } from "../src/spec.ts";
import { accessorReferences } from "../src/validate.ts";

/**
 * `accessorReferences` (src/validate.ts) against the emitter it describes.
 *
 * The rule it states is entry-scoped by necessity — a shared claim map rejects four fixtures, two
 * of them byte-locked — and the price of that is a second copy of `renderEnvAccessor`'s branch
 * structure living in the validator. This file is what keeps the copy honest: it reads the names
 * out of the REAL emitted accessor for every branch, so a splice site that starts referencing a
 * new module-scope name fails here instead of shipping as a binding nobody guards.
 *
 * Same discipline as test/raw-splice.test.ts, and for the same reason: a test that looped over
 * `accessorReferences`'s own return value would confirm only that it agrees with itself.
 */

/**
 * Blank out comments and the LITERAL text of every string, keeping `${…}` expression bodies,
 * which are code.
 *
 * Character-scanned rather than matched with a regex, and that is not fastidiousness. The regex
 * version of this was written first: a template-literal pattern has to stop at `${`, so it fails
 * to match an interpolating template, then resumes at that template's CLOSING backtick and runs
 * to the next template's opening one — silently deleting every statement in between. It reported
 * a clean-looking answer that was missing `JSON`, `Math`, `Number`, `parsed` and `ttl`, five of
 * the names this file exists to find.
 */
function codeOnly(src: string): string {
  let out = "";
  let i = 0;
  // Template-literal nesting: "`" while inside quasi text, "{" while inside a `${…}` or a plain
  // brace within one. Only the innermost matters, hence a stack rather than a counter.
  const depth: string[] = [];
  while (i < src.length) {
    const c = src[i]!;
    const two = src.slice(i, i + 2);
    const inQuasi = depth.at(-1) === "`";
    if (!inQuasi && two === "//") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (!inQuasi && two === "/*") {
      i += 2;
      while (i < src.length && src.slice(i, i + 2) !== "*/") i++;
      i += 2;
      continue;
    }
    if (inQuasi) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (two === "${") {
        depth.push("{");
        out += " ";
        i += 2;
        continue;
      }
      if (c === "`") {
        depth.pop();
        out += " ";
        i++;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i++;
      continue;
    }
    if (c === "`") {
      depth.push("`");
      out += " ";
      i++;
      continue;
    }
    if (c === "{" && depth.length > 0) {
      depth.push("{");
      out += c;
      i++;
      continue;
    }
    if (c === "}" && depth.length > 0) {
      depth.pop();
      out += depth.at(-1) === "`" ? " " : c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i++;
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Words a name cannot collide with because they are not names: syntax and type-position spellings. */
const KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "async",
  "await",
  "return",
  "if",
  "else",
  "for",
  "of",
  "in",
  "throw",
  "new",
  "typeof",
  "instanceof",
  "true",
  "false",
  "null",
  "this",
  "void",
  "export",
  "import",
  "class",
  "try",
  "catch",
  "finally",
  "switch",
  "case",
  "default",
  "do",
  "while",
  "as",
  // Type positions. A `const Promise = …` shadows the VALUE; `Promise<string>` resolves in the
  // type namespace, which a const does not occupy — compiled to confirm, for each of these.
  "string",
  "number",
  "boolean",
  "unknown",
  "any",
  "never",
  "Record",
  "Promise",
]);

/**
 * Every identifier the emitted accessor references, as opposed to declares or spells as a key.
 *
 * Deliberately an OVER-approximation. It does not model regex literals (see `$` below) and its
 * property-position handling is textual, so a construct it does not know leaks extra words —
 * which makes this test FAIL LOUDLY and never pass wrongly. That is the direction a guard has to
 * err in, and it is the direction the earlier regex version got backwards.
 */
function referencedWords(src: string): string[] {
  const noProps = codeOnly(src).replaceAll(/\.\s*[A-Za-z_$][\w$]*/g, ".");
  const noKeys = noProps.replaceAll(/([A-Za-z_$][\w$]*)\s*\??\s*:/g, ":");
  const out = new Set<string>();
  for (const m of noKeys.matchAll(/[A-Za-z_$][\w$]*/g)) if (!KEYWORDS.has(m[0])) out.add(m[0]);
  return [...out].sort();
}

/**
 * Words the scan reports that no binding can collide with, each with the reason it is here rather
 * than in `accessorReferences`. Two entries, and neither may grow without an argument.
 */
const NOT_COLLIDABLE: Record<string, string> = {
  $: 'the `$` of `.replace(/\\/$/, "")` — a regex literal, which codeOnly does not model',
  token:
    "the name renderTokenFunction gives the ENCLOSING function; its body never calls it, only " +
    "the wrapper accessor below does, from a different scope — compiled clean as a binding",
};

/** Every branch of renderEnvAccessor, by the fields that select it. */
const SHAPES: readonly (readonly [string, Record<string, unknown>])[] = [
  ["plain, required", { vars: ["V1"], local: "acc", required: true }],
  ["plain, defaulted (no guard)", { vars: ["V1"], local: "acc", default: "d" }],
  ["plain, neither (no guard)", { vars: ["V1"], local: "acc" }],
  [
    "plain, prefix/suffix",
    { vars: ["V1"], local: "acc", required: true, prefix: "p-", suffix: "-s" },
  ],
  [
    "plain, stripTrailingSlash",
    { vars: ["V1"], local: "acc", required: true, transform: "stripTrailingSlash" },
  ],
  [
    "plain, trimTrailingSlashFn",
    { vars: ["V1"], local: "acc", required: true, transform: "trimTrailingSlashFn" },
  ],
  ["bearer", { vars: ["V1"], local: "acc", auth: "bearer" }],
  ["bearer, split", { vars: ["V1"], local: "acc", auth: "bearer", tokenLocal: "rawTok" }],
  ["headers, one var", { vars: ["V1"], local: "acc", auth: "headers", headerNames: ["X-A"] }],
  [
    "headers, two vars",
    { vars: ["V1", "V2"], local: "acc", auth: "headers", headerNames: ["X-A", "X-B"] },
  ],
  ["basic", { vars: ["V1", "V2"], local: "acc", auth: "basic" }],
  ["basic, prefix/suffix", { vars: ["V1", "V2"], local: "acc", auth: "basic", prefix: "p-" }],
  [
    "client-credentials, basic",
    {
      vars: ["V1", "V2"],
      local: "acc",
      auth: "client-credentials",
      tokenUrl: "https://t.test/t",
      credentialsIn: "basic",
    },
  ],
  [
    "client-credentials, body + scope",
    {
      vars: ["V1", "V2"],
      local: "acc",
      auth: "client-credentials",
      tokenUrl: "https://t.test/t",
      credentialsIn: "body",
      scope: "a b",
    },
  ],
];

/** Names the entry itself contributes, which are not what this rule is about. */
const DECLARED = ["B0", "B1", "acc", "rawTok"];

function shapeEntry(raw: Record<string, unknown>): EnvSpec {
  const bindings = (raw["vars"] as string[]).map((_, i) => `B${i}`);
  return EnvSchema.parse({ ...raw, bindings });
}

describe("accessorReferences names exactly what the emitted accessor reads", () => {
  for (const [label, raw] of SHAPES) {
    it(`matches the emitter for ${label}`, () => {
      const e = shapeEntry(raw);
      const found = referencedWords(renderEnvAccessor(e, "Svc")).filter(
        (w) => !DECLARED.includes(w) && !Object.hasOwn(NOT_COLLIDABLE, w),
      );
      expect(found).toEqual([...new Set(accessorReferences(e))].sort());
    });
  }

  it("is non-vacuous: the scan finds names, and finds different sets for different branches", () => {
    // Without this, a `codeOnly` that returned "" would make every case above compare [] to [] —
    // which it could only do if `accessorReferences` also returned nothing, but the two failing
    // together is exactly how a pair of mirrored lists agrees with itself about nothing.
    const plain = referencedWords(renderEnvAccessor(shapeEntry(SHAPES[0]![1]), "Svc"));
    const cc = referencedWords(renderEnvAccessor(shapeEntry(SHAPES.at(-1)![1]), "Svc"));
    expect(plain.length).toBeGreaterThan(2);
    expect(cc.length).toBeGreaterThan(plain.length + 8);
  });

  it("keeps ${…} expressions while dropping the text around them", () => {
    // codeOnly's whole premise, on an input with both, since the accessors it is pointed at
    // cannot demonstrate the case it gets wrong until an emitter change introduces one.
    const scanned = codeOnly('const a = `lit ${call(x)} tail`; const b = "quoted";');
    expect(scanned).toContain("call(x)");
    expect(scanned).not.toContain("lit");
    expect(scanned).not.toContain("tail");
    expect(scanned).not.toContain("quoted");
  });
});
