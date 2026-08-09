import { z } from "zod";

/**
 * Tool keys rejected with a targeted message rather than Zod's generic "unrecognized key".
 * Detected before Zod so the error explains the boundary and names the alternative.
 *
 * The message used to read "is not supported in Stage A (… a later Stage C task)". Stage C
 * happened, and it did not add `hitl` — the manifest's `hitlRequired` array is computed from
 * each tool's `effect` instead, deliberately: `hitlRequired` is a manifest-level capability
 * array in all 94 corpus connectors, never per-tool, so a per-tool key would have no shape to
 * emit into. The message now says what is true and what to write instead, and does not
 * promise a stage.
 */
const OUT_OF_SCOPE_TOOL_KEYS: Record<string, string> = {
  hitl: 'HITL is not declared per tool; use "effect": "write" | "delete", which is what the manifest\'s hitlRequired array is computed from',
};

/**
 * Every `local` field becomes an emitted identifier (a function name, a hoisted
 * const name), so it is held to the same rule as tool argument keys — a valid
 * JS identifier, not just a non-empty string.
 */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The words `IDENTIFIER_RE` matches that a declaration position will not take.
 *
 * `bindings: ["class"]` emitted `const class = process.env["ZZ_V"]?.trim();` — a PARSE error
 * against the generator's own output, which surfaces as `formatAll` failing in Biome rather
 * than as a named spec error. Same failure mode as `rows: "data-items"`, one field over, and
 * the regex above matched every reserved word there is.
 *
 * **Derived by generating, not written from memory.** The candidate universe was extracted from
 * two installed packages rather than typed out: every `createKeyword("…")` and
 * `createKeywordLike("…")` in `@babel/parser`'s lib, plus the `keyword`/`strict`/`strictBind`
 * tables in `@babel/helper-validator-identifier` — which is where `package`, `private`,
 * `protected`, `public`, `eval` and `arguments` come from, six words neither of the parser's own
 * keyword tables carries because strict mode, not the tokenizer, is what reserves them — plus
 * twenty TypeScript type-space spellings added as controls. Each was then put through the real
 * generator in each of the ten identifier positions the spec language has, for both targets, and
 * the emitted files were handed to the real Biome. A word is here if and only if Biome refused to
 * parse the result.
 *
 * **95 candidates, 48 of them here**, measured against @babel/parser 8.0.4 and
 * @babel/helper-validator-identifier 8.0.4 — the versions are stated because the count moves with
 * them, and a count with nothing to date it is what this repository's own rule forbids.
 * test/reserved-words.test.ts re-derives the answer on every run and asserts floors rather than
 * these numbers, so a version that adds a contextual keyword updates the rule instead of
 * failing it.
 *
 * The 48 below broke in NINE of the ten positions — every declaration position there is — and
 * the tenth (a tool argument key) is discussed at its own call site. The other 47 emitted clean
 * and are deliberately absent: `type`, `as`, `any`, `namespace`, `declare`, `readonly`,
 * `satisfies`, `keyof`, `infer`, `is`, `out`, `override`, `accessor`, `using`, `async`, `of`,
 * `from`, `get`, `set`, `global`, `module`, `require`, `assert`, `unique` and the rest are
 * contextual in TypeScript and are ordinary identifiers in a declaration. Refusing them would
 * reject specs that work, which is a real cost and not a safe default.
 *
 * `undefined`, `NaN` and `Infinity` are not here either — they parse. They are GLOBALS the
 * emitted code reads, which is `RESERVED_IDENTIFIERS`' business (src/validate.ts), not this
 * regex's.
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/**
 * What every emitted identifier has to satisfy: the shape, and then the word.
 *
 * `regexMessage` is the only thing that varies. Tool argument keys said "argument name must be a
 * valid JS identifier" through a second copy of `IDENTIFIER_RE` written inline in `ToolSchema`,
 * and a second copy is how the reserved-word hole stayed open in that field after being closed
 * everywhere else. There is one rule now, and one place to change it.
 *
 * `hint` closes the message with what to do instead, which differs by field: an emitted
 * identifier is internal and can simply be renamed, while an argument key an author chose to
 * match an API's own parameter name has a wire spelling to preserve.
 */
const RENAME_HINT =
  "Rename it — an emitted identifier is internal to the generated package and appears nowhere " +
  "on the wire.";

/**
 * Whether a name is one of the words above — exported for the ONE caller that has to ask before
 * a spec exists.
 *
 * `src/openapi/operation.ts` builds argument names out of a document and refuses the bad ones
 * where the document names them, so `--from-openapi` reports the parameter the user wrote rather
 * than a path into an assembled spec they never saw. It cannot call `parseSpec` to find out — by
 * then the position is lost. A fourth private copy of the word list is exactly the mistake the
 * arg-key rule already made with the regex, so the list stays here and the question is exported.
 */
export function isReservedWord(name: string): boolean {
  return RESERVED_WORDS.has(name);
}

function identifierField(
  regexMessage = "must be a valid JS identifier",
  hint: string = RENAME_HINT,
) {
  return z
    .string()
    .regex(IDENTIFIER_RE, regexMessage)
    .superRefine((v, ctx) => {
      if (!RESERVED_WORDS.has(v)) return;
      ctx.addIssue({
        code: "custom",
        message:
          `${JSON.stringify(v)} is a JavaScript reserved word. Every identifier field is ` +
          "spliced into a declaration position in the generated source — `const <name> = …`, " +
          "`function <name>(…)`, `export function <name>(…)` — where a reserved word does not " +
          "parse, so the generator fails inside its own formatter instead of reporting a spec " +
          `error. ${hint}`,
      });
    });
}

/* ------------------------------------------------------------------------------------------ *
 * The path-template DSL: `${env.X}`, `${arg.X}`, `${arg.X|enc|num|bool|raw}`
 *
 * This is the PARSER, and it lives here — beside `resolveKeyedShape` and `needsExtractor` —
 * because `tool.path` is a field of the SPEC, so what its placeholders mean is the spec
 * language's question, not the emitter's. Three layers need the answer and none of them owns
 * it: `src/validate.ts` reads the segments to check that every `${arg.X}` names a declared
 * argument, `src/emit/server/path-template.ts` renders them, and `src/derive/server/body.ts`
 * reconstructs the default write body from the same set of path-referenced args the emitter
 * excluded.
 *
 * That deriver import is the reason this is a parser and not a copy. A private copy that
 * UNDER-parses leaves an arg in the default body set and emits a spurious explicit `body` that
 * is byte-identical to the correct output — invisible to `diff:golden`, to the round trip and
 * to every other gate — while one that over-parses throws. Sharing removes the only direction
 * nothing can see.
 *
 * The boundary that makes that safe: `src/derive/` may share the spec language's **parser**,
 * never the emitter's **renderer**. `renderPath` stays in `src/emit/server/path-template.ts`,
 * because comparing rendered text against observed source would let a renderer bug agree with
 * itself and disappear.
 * ------------------------------------------------------------------------------------------ */

export type ArgMode = "raw" | "enc" | "num" | "bool";

export type PathSegment =
  | { kind: "literal"; text: string }
  | { kind: "env"; name: string }
  | { kind: "arg"; name: string; mode: ArgMode };

const MODES = new Set<string>(["raw", "enc", "num", "bool"]);
const PLACEHOLDER = /\$\{([a-z]+)\.(\w+)(?:\|([a-z]+))?\}/g;

/**
 * The two placeholder conventions a user is most likely to reach for by habit — OpenAPI's
 * `{id}` and Express's `/:id` — neither of which this generator interpolates.
 *
 * They are caught rather than passed through because passing them through is silent and
 * wrong: `"/items/{id}"` emits `vcGet("/items/{id}")`, which compiles, typechecks, passes
 * every gate, and requests a URL containing the literal characters `{id}`. Nothing fails
 * until the connector is pointed at a real API.
 *
 * The Express arm requires the colon to follow a slash. A bare `:name` would false-positive
 * on query values that legitimately contain one — sentry's fixture path carries
 * `?query=is:unresolved`, and `is:unresolved` is not a placeholder.
 */
const FOREIGN_PLACEHOLDER = /\{([A-Za-z_]\w*)\}|\/:([A-Za-z_]\w*)/;

/** One matched `${ns.name|mode}` placeholder, as the segment it denotes. */
function toPlaceholderSegment(
  whole: string,
  ns: string | undefined,
  name: string,
  mode: string | undefined,
): PathSegment {
  if (ns === "env") {
    if (mode !== undefined) throw new Error(`env placeholder "${whole}" cannot take a mode`);
    return { kind: "env", name };
  }
  if (ns !== "arg") {
    throw new Error(`Unknown placeholder namespace "${ns}" in "${whole}"`);
  }
  const m2 = mode ?? "raw";
  if (!MODES.has(m2)) throw new Error(`Unknown placeholder mode "${m2}" in "${whole}"`);
  return { kind: "arg", name, mode: m2 as ArgMode };
}

/**
 * Reject anything left in a literal segment that only *looks* like a placeholder: a `${`
 * this parser did not consume (wrong case, wrong shape), or one of the two foreign
 * conventions FOREIGN_PLACEHOLDER describes.
 */
function assertNoUnparsedPlaceholders(segments: readonly PathSegment[]): void {
  for (const seg of segments) {
    if (seg.kind !== "literal") continue;
    if (seg.text.includes("${")) {
      throw new Error(
        `Malformed placeholder in path template: ${JSON.stringify(seg.text)}. ` +
          "Expected ${env.NAME} or ${arg.NAME} with an optional |raw, |enc, |num or |bool mode; " +
          "namespace and mode must be lowercase.",
      );
    }
    const foreign = FOREIGN_PLACEHOLDER.exec(seg.text);
    if (foreign !== null) {
      throw new Error(
        `Path template uses ${foreign[0]}, which this generator does not interpolate: ` +
          `${JSON.stringify(seg.text)}. It would be emitted as a literal path segment, and ` +
          `the connector would request the characters "${foreign[0]}" instead of a value. ` +
          `Use \${arg.${foreign[1] ?? foreign[2]}|enc} instead.`,
      );
    }
  }
}

export function parsePathTemplate(tpl: string): PathSegment[] {
  const out: PathSegment[] = [];
  let last = 0;
  for (const m of tpl.matchAll(PLACEHOLDER)) {
    const [whole, ns, name, mode] = m;
    const at = m.index;
    if (at > last) out.push({ kind: "literal", text: tpl.slice(last, at) });
    out.push(toPlaceholderSegment(whole, ns, name!, mode));
    last = at + whole.length;
  }
  if (last < tpl.length) out.push({ kind: "literal", text: tpl.slice(last) });

  assertNoUnparsedPlaceholders(out);

  return out;
}

/**
 * The sequences that break out of the construct a raw-spliced spec string is emitted into.
 *
 * **The rule this list serves: every spec string an emitter splices into generated source
 * unquoted goes through `rawSplicedString`.** This docstring used to open by counting the
 * fields that do — "Two fields are spliced with no quoting or escaping" — and the count was
 * wrong when it was written. Six more carried the same splice, one of them (`env[].prefix`)
 * putting an attacker-supplied IIFE into the Authorization header of every request. A number in
 * prose is precisely the artefact that makes the next reader stop looking, so there is no number
 * here now and there must not be one again. `test/raw-splice.test.ts` DERIVES the carrier set by
 * probing the emitters with a marker no quoting scheme leaves intact, and fails when a new
 * carrier appears; that census, not this comment, is the authority on which fields are raw.
 *
 * Every sequence below is rejected in EVERY guarded field, including where the field does not
 * reach that construct today. The rule belongs to the field rather than to the splice site,
 * because splice sites are what emitter changes add: `serviceLabel`'s own comment site
 * (src/emit/wiring.ts, Stage C) arrived a day after its two template sites, and nothing about
 * that change would have prompted anyone to revisit a per-site rule.
 *
 * The backslash is not a terminator, and it is here because the omission of an ESCAPE is the
 * same hole one step sideways: it changes the meaning of the character after it rather than
 * ending anything. A `base` of `https://api.zz.test/v1\` emits
 * `` `https://api.zz.test/v1\${path}` ``, in which `\$` is an escape — so the template's value
 * is the literal text `https://api.zz.test/v1${path}`, the path is never interpolated, and the
 * connector requests that URL verbatim. Valid TypeScript, clean under Biome and under the
 * generated package's own tsc, and silent until the connector is pointed at a real API: exactly
 * the failure class `FOREIGN_PLACEHOLDER` above exists for.
 */
const RAW_SPLICE_TERMINATORS = [
  { seq: "`", named: "a backtick", effect: "ends a template literal" },
  { seq: "*/", named: "a block comment terminator", effect: "ends a block comment" },
  {
    seq: "\\",
    named: "a backslash",
    effect:
      "escapes the character after it, so a ${…} that follows is emitted as literal text " +
      "instead of an interpolation",
  },
] as const;

/**
 * The one `${…}` shape an emitter RESOLVES, so that it stops being interpolation before it
 * reaches generated source.
 *
 * This mirrors `resolveEnvRefs` (src/emit/server/fetch-helper.ts) — the function that performs
 * the rewrite, and therefore the authority on which references are not live. `baseExpr` is the
 * exported entry point that runs it, and "accepts %j exactly when the emitter resolves every
 * interpolation in it" in test/spec.test.ts holds this rule against that function's real output
 * rather than against a second copy of this pattern, so a `resolveEnvRefs` that widens or narrows
 * fails there instead of quietly disagreeing with this file.
 *
 * Note what is NOT reused: `headerOption` (same file) tests an inline header value with an
 * ANCHORED `/^\$\{env\.\w+\}$/`, because a header value either is one reference or is a plain
 * string. A base is a template — `https://${env.siteHost}/api` is the shape every fixture that
 * uses one actually writes — so the question here is per-occurrence, "is every `${` in this
 * string one of these", not "is this string one of these".
 */
const RESOLVED_ENV_REF = /\$\{env\.(\w+)\}/g;

/**
 * The env-accessor names a base or inline-header template references, in occurrence order.
 *
 * Exported so `validateSpec` can ask *which* accessors a template names without restating the
 * pattern. `isEnvRefHeaderValue`'s docstring gives the reason at length: a second copy of this
 * pattern is how the mixed-header bug stayed open, and there are already two copies in the tree
 * (here and `resolveEnvRefs`, pinned against each other by "accepts %j exactly when the emitter
 * resolves every interpolation in it" in test/spec.test.ts). A third, in the validator, would be
 * the same mistake a layer down.
 *
 * **The group is why `RESOLVED_ENV_REF` captures at all**, and it costs its own consumer nothing:
 * the only other use is `v.replaceAll(RESOLVED_ENV_REF, "")` in `rawSplicedString`, where a string
 * replacement ignores captures. Reading the name out of the shared pattern rather than rebuilding
 * a capturing copy of it keeps this to one regex — an earlier revision derived the capturing form
 * with `.source.replace("\\w+", "(\\w+)")`, which was two patterns wearing a trench coat and put
 * the shape in a string literal where no regex-aware tool could see it.
 *
 * Nothing here judges whether the name resolves — `validateSpec` owns that, because it is the
 * only layer that can see `spec.env` and the fetch helper at once.
 */
export function envRefNames(tpl: string): string[] {
  return [...tpl.matchAll(RESOLVED_ENV_REF)].map(([, name]) => name!);
}

/**
 * Whether an inline header VALUE is the one shape `headerOption` (src/emit/server/fetch-helper.ts)
 * resolves: a reference and nothing else.
 *
 * **Exported and CALLED by `headerOption` itself**, on the precedent `canOmitQueryValue` set —
 * not restated beside it. That is what makes `FetchHelperSchema`'s refusal below and the
 * emitter's branch the same test rather than two that agree today. Restating it is how the bug
 * this closes stayed open: `headerOption` falls through to `JSON.stringify(v)` for anything this
 * returns `false` for, so `"Bearer ${env.apiKey}"` — a value that plainly means to reference the
 * credential — emitted `Authorization: "Bearer ${env.apiKey}"` and put those literal characters
 * on the wire. Accepted at parse time, discarded at emit time; the connector compiles, lints,
 * typechecks and authenticates against nothing.
 *
 * Anchored, unlike `RESOLVED_ENV_REF`'s per-occurrence sweep, and the difference is the two
 * fields': a header value either IS one reference or is a plain string, while a base is a
 * template with references embedded in surrounding text.
 */
export function isEnvRefHeaderValue(v: string): boolean {
  return /^\$\{env\.\w+\}$/.test(v);
}

/**
 * How a raw-spliced field's `${…}` is disposed of, which is the one thing the guarded fields do
 * not share.
 *
 * A `RegExp` is the shape an EMITTER rewrites before emission, stripped before the residue is
 * scanned. `undefined` means the field takes no interpolation at all. `"path-template"` means the
 * field is a path template, where `${…}` is the DSL's own and `parsePathTemplate` — not this
 * refinement — decides which spellings are legal; it already refuses every `${` it did not
 * consume, with a message naming the modes, so restating that here would produce two rejections
 * for one mistake and one of them would be the vaguer.
 */
type SpliceInterpolation = RegExp | undefined | "path-template";

/** One issue as the raw-splice refinement raises it: a message, at the field zod is checking. */
type AddSpliceIssue = (message: string) => void;

/**
 * The terminator half, factored out because `tools[].path` needs it WITHOUT the interpolation
 * half — see `SpliceInterpolation`. Splitting the two is what lets the terminator set stay one
 * list applied uniformly to every carrier, which is the whole claim `RAW_SPLICE_TERMINATORS`
 * makes about itself.
 */
function refuseTerminators(field: string, sites: string, v: string, add: AddSpliceIssue): void {
  for (const t of RAW_SPLICE_TERMINATORS) {
    if (!v.includes(t.seq)) continue;
    add(
      `"${field}" contains ${t.named} (${JSON.stringify(t.seq)}), which ${t.effect}. ` +
        `This field is spliced raw into generated source (${sites}), so the sequence stops ` +
        "being text: what follows it is emitted as something other than what was written, and " +
        "the result still compiles, lints and typechecks, so nothing downstream reports it. " +
        "Every sequence in this set is refused in every raw-spliced field, including where the " +
        "field does not reach that construct today.",
    );
  }
}

/**
 * A spec string the emitter splices RAW into generated source, refused if it can end the
 * construct it lands in, or if it opens an interpolation nothing resolves.
 *
 * This is the only place that catches either. The emitters quote nothing (proved on the emitter
 * itself by "splices `base` raw" in test/emit/server/fetch-helper.test.ts), and the resulting
 * file is VALID TypeScript — `"https://api.zz.test/v1` + String(Date.now()) + `"` as a base emits
 * a call expression between two literals, which Biome reformats and `tsc --noEmit --strict`
 * accepts. Every gate downstream of the schema therefore reports green. Rejecting at the schema
 * rather than at the splice sites is also what covers all three ways a spec is authored at once —
 * hand-written, `--from-connector`, `--from-openapi`.
 *
 * `resolves` is the one thing the guarded fields do not share, and they differ because the
 * EMITTERS do. Three dispositions, named by `SpliceInterpolation` above:
 *
 *   - `undefined` — nothing rewrites anything in the field, so every `${` it carries is live and
 *     all of them are refused. `serviceLabel`, `tools[].name`, `env[].prefix`, `env[].suffix`.
 *   - a `RegExp` — the shape an emitter resolves, stripped before the residue is scanned, so
 *     every OTHER `${` is refused. `fetchHelper.base` and `RESOLVED_ENV_REF`, because `${env.X}`
 *     there is a documented feature: it is what 7 of the 23 fixtures write, three of them the
 *     byte-locked datadog, grafana and sentry, so banning `${` outright would fail diff:golden on
 *     the first run, and `bun run reach --baseline` says the same of the specs the deriver
 *     reconstructs from the corpus. The residue left once the resolved shape is removed is
 *     exactly what survives into the emitted template literal.
 *   - `"path-template"` — the field is the path DSL and `parsePathTemplate` owns the question.
 *     `tools[].path`, and this is not a rare case: `${` appears in a `tools[].path` in 20 of the
 *     23 fixtures, against 7 for `fetchHelper.base` (measured 2026-08-09 over `fixtures/*.spec.json`).
 *     Every one of those is a placeholder the DSL consumes, and `assertNoUnparsedPlaceholders`
 *     already refuses every spelling it did not — which is why a second rule here would produce
 *     two rejections for one mistake.
 *
 * **An earlier version of this rule admitted `${` wherever it appeared**, on the grounds that an
 * unresolved one produces an UNDEFINED IDENTIFIER the generated package's own `tsc --noEmit`
 * reports. That is true of `${x}` and of nothing else. An interpolation whose expression is
 * self-contained — `${(() => { … })()}`, which names nothing outside itself — leaves no identifier
 * to be undefined: it compiles, lints and typechecks clean and then RUNS, in `base` on every
 * request and in `serviceLabel` on every non-2xx response. Loud-versus-silent was the wrong line
 * to draw the rule on, because it is a property of one payload rather than of the field.
 *
 * Measured across the 23 fixtures: no guarded field carries a backtick, a block-comment
 * terminator or a backslash — which this docstring cannot spell out literally, the hazard in
 * miniature.
 *
 * `emptyIsMeaningful` exists for one carrier pair. `wrapped()` (src/emit/server/env.ts)
 * substitutes `?? ""` for whichever of `prefix`/`suffix` is unset, so `""` and omitted emit
 * identical bytes — and `classifyPlainReturn` (src/derive/server/env.ts) reads both from the
 * template's cooked quasis unconditionally, which means `--from-connector` genuinely produces
 * `""` for the unused side. A `.min(1)` on those two would reject a spec this repository's own
 * deriver writes, and `reach --baseline` is where that would have been found.
 */
function rawSplicedString(
  field: string,
  sites: string,
  resolves: SpliceInterpolation,
  emptyIsMeaningful = false,
) {
  return (emptyIsMeaningful ? z.string() : z.string().min(1)).superRefine((v, ctx) => {
    const add: AddSpliceIssue = (message) => ctx.addIssue({ code: "custom", message });
    refuseTerminators(field, sites, v, add);

    if (resolves === "path-template") return;

    // Named for the claim it gates — an interpolation still live in the generated package —
    // rather than for the residue that reveals it.
    const hasLiveInterpolation = (resolves === undefined ? v : v.replaceAll(resolves, "")).includes(
      "${",
    );
    if (!hasLiveInterpolation) return;
    add(
      `"${field}" opens an interpolation (\${…}) that no emitter resolves. This field is ` +
        `spliced raw into generated source (${sites}), so the expression inside it is emitted ` +
        "as an expression and evaluated at runtime. A self-contained one names nothing " +
        "outside itself, so it compiles, lints and typechecks clean — nothing downstream " +
        "reports it. " +
        (resolves === undefined
          ? "This field takes no interpolation at all: no emitter rewrites a reference in it."
          : "The only interpolation this field takes is ${env.NAME}, which resolveEnvRefs " +
            "(src/emit/server/fetch-helper.ts) rewrites to an accessor call before emission."),
    );
  });
}
export const ArgSchema = z
  .strictObject({
    type: z.enum(["string", "number", "boolean"]),
    optional: z.boolean().default(false),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    /** Hoisted const name. Cosmetic; defaults to the arg's own key. */
    local: identifierField().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    int: z.boolean().default(false),
  })
  .refine((a) => !(a.type === "boolean" && a.default !== undefined), {
    message: 'a boolean argument cannot declare "default" — the generated hoist ignores it',
  })
  .refine((a) => a.type !== "boolean" || (a.min === undefined && a.max === undefined), {
    message: '"min"/"max" are not valid on a boolean argument',
  })
  .refine((a) => a.type === "number" || !a.int, {
    message: '"int" is only valid on a number argument',
  })
  .refine((a) => a.default === undefined || a.optional, {
    message:
      'an argument declaring "default" must also declare "optional": true — a required ' +
      "argument's default can never be reached, since the schema demands a value",
  });

/**
 * One searchable field. A plain string is a top-level key; `path` reads a nested one via the
 * shared `nestedString`; `tags` selects one of the two shared tag helpers.
 *
 * The union is untagged because the required-key sets are disjoint — an entry is a string, or
 * has `path`, or has `tags`. A `"type"` discriminator was declined in review: it is paid on
 * every entry an author writes, and a future kind is either a new disjoint shape or an optional
 * key on an existing one.
 */
const PathEntrySchema = z.strictObject({
  path: z.array(z.string().min(1, "a path segment cannot be empty")),
});

const TagsEntrySchema = z.strictObject({
  /** "text" -> tagText (a string[] under `tags`); "objects" -> tagNamesFromObjects ({name}[]). */
  tags: z.enum(["text", "objects"]),
});

/**
 * The custom error is not decoration. Verified against zod 4.4.2: a failing untagged union
 * reports a single issue whose default message is "Invalid input" — it names neither what was
 * given nor what was expected. (It does *not* dump one failure per branch; that is zod 3
 * behaviour.) This message is the only thing that makes a malformed entry actionable.
 */
const FieldEntrySchema = z.union([z.string().min(1), PathEntrySchema, TagsEntrySchema], {
  error:
    'a field entry must be a key string, { "path": [...] } with two or more segments, or ' +
    '{ "tags": "text" | "objects" }',
});

export type FieldEntry = z.infer<typeof FieldEntrySchema>;

export function isPathEntry(e: FieldEntry): e is z.infer<typeof PathEntrySchema> {
  return typeof e === "object" && "path" in e;
}

function isTagsEntry(e: FieldEntry): e is z.infer<typeof TagsEntrySchema> {
  return typeof e === "object" && "tags" in e;
}

/**
 * The fieldsFromKeys-compatible shape for a filter's entries, or undefined when at least one
 * entry needs the bespoke `fieldsOf` extractor instead — a `path` entry, a `{"tags":"objects"}`
 * entry, or a `{"tags":...}` entry anywhere but last.
 *
 * `fieldsFromKeys` appends `tagText(row)` *after* the keyed fields when `opts.tags` is set, so
 * a trailing `{ tags: "text" }` is byte-identical to legacy `tags: true` and converges onto
 * this shape — an author who prefers the newer spelling does not silently lose a byte-match.
 * Trailing is load-bearing: that helper can only append, so a tag entry in any other position
 * changes field order and cannot converge. `{ tags: "objects" }` has no equivalent —
 * fieldsFromKeys hardcodes tagText.
 *
 * This is the single source of truth for "does this filter take the extractor branch": the
 * schema's own superRefine (below), `validateSpec`'s at-most-one-extractor rule, and the
 * emitter's `keyedShape` all derive from it rather than restating the rule.
 */
export function resolveKeyedShape(
  fields: readonly FieldEntry[],
): { keys: readonly string[]; trailingTagText: boolean } | undefined {
  const last = fields.at(-1);
  const trailingTagText = last !== undefined && isTagsEntry(last) && last.tags === "text";
  const body = trailingTagText ? fields.slice(0, -1) : fields;
  if (!body.every((e): e is string => typeof e === "string")) return undefined;
  return { keys: body, trailingTagText };
}

/**
 * Whether a filter's fields require the bespoke `fieldsOf` extractor rather than
 * `fieldsFromKeys`. `fields` omitted is the throwing-stub branch, not the extractor — this is
 * `false` for it.
 */
export function needsExtractor(filter: { fields?: readonly FieldEntry[] }): boolean {
  return filter.fields !== undefined && resolveKeyedShape(filter.fields) === undefined;
}

/**
 * The per-connector search filter. `fields` omitted means the emitter cannot express the
 * extraction and emits a throwing stub instead — of the 40 corpus filter files that hand-write
 * an extractor, 26 can be expressed with these entry kinds and 14 cannot, the latter needing a
 * join over a non-`tags` array, a numeric coercion, an alternate tag shape, or a conditional
 * search. Defining a local helper does NOT by itself put a file out of reach: a helper that
 * walks a nested path is exactly a `path` entry, which is why an earlier count said 9. See
 * ROADMAP's "Measuring reach" for the method.
 */
export const SearchFilterSchema = z
  .strictObject({
    export: identifierField(),
    fields: z.array(FieldEntrySchema).min(1, "a filter must name at least one field").optional(),
    tags: z.boolean().default(false),
  })
  .superRefine((f, ctx) => {
    if (f.fields === undefined) return;

    for (const [i, e] of f.fields.entries()) {
      // A one-segment path and a plain key emit identical output. Accepting both spellings for
      // one emission is an ambiguity, and normalising it silently would hide a likely typo.
      if (isPathEntry(e) && e.path.length < 2) {
        const only = e.path[0];
        ctx.addIssue({
          code: "custom",
          path: ["fields", i, "path"],
          message:
            `"path": ${JSON.stringify(e.path)} has fewer than two segments. A single-segment ` +
            `path emits the same call as the plain key ${JSON.stringify(only ?? "")} — write ` +
            "the plain string form instead.",
        });
      }
    }

    // A precedence rule here would be invisible in the emitted file, so both spellings at once
    // is an error rather than one winning.
    if (f.tags && f.fields.some(isTagsEntry)) {
      ctx.addIssue({
        code: "custom",
        path: ["tags"],
        message:
          'a filter sets legacy "tags": true and also lists a { "tags": ... } entry in ' +
          '"fields". Use one: the entry form if you need "objects", otherwise "tags": true.',
      });
    }

    // extractorFilter (src/emit/search-filter.ts) reads only "fields" — it never consults
    // "tags" — so a legacy "tags": true on a filter that takes the extractor branch is
    // silently dropped: the connector compiles and passes every gate while failing to match
    // on tags. The .some(isTagsEntry) case above already rejects the overlapping case (a tags
    // entry anywhere alongside "tags": true), so this only needs to catch the entry-free
    // cause — a "path" entry forcing the extractor branch with no { "tags": ... } in sight.
    if (f.tags && !f.fields.some(isTagsEntry) && needsExtractor(f)) {
      ctx.addIssue({
        code: "custom",
        path: ["tags"],
        message:
          'a filter sets legacy "tags": true, but its "fields" need a bespoke extractor (a ' +
          '"path" entry forces this) — the extractor never reads "tags", so it would be ' +
          'silently dropped. Add { "tags": "text" } as the last entry in "fields" instead.',
      });
    }
  });

/**
 * Whether a query entry's value can genuinely be `undefined` at the point
 * `renderQueryLines` (src/emit/server/query.ts) reads it — i.e. whether `omitWhen`'s guard
 * has anything to omit. Requires all three: `"optional": true` (a required arg's value
 * always exists by the time the handler runs), no `"default"` (the hoist emits
 * `p.x ?? <default>`, never `undefined`), and not type `"boolean"` (`isHoisted` in
 * `src/emit/server/args.ts` hoists every boolean regardless of `default`, and
 * `renderHoists` emits `p.x === true ? "true" : "false"`, also never `undefined`).
 *
 * One predicate governs both directions of "does `omitWhen` make sense on this entry", so
 * they cannot independently drift: `omitWhen` SET on an arg this returns `false` for is a
 * dead guard (can never omit); `omitWhen` ABSENT on an arg this returns `true` for is a
 * missing guard — `searchParams.set` receives a value that can be `undefined`, which is
 * `TS2345` for a string arg (the wrapped-in-`String()` cases compile, but send the literal
 * query value `"undefined"` on the wire, since `String(undefined) === "undefined"`).
 *
 * **Exported for a third consumer**, on the same reasoning `parsePathTemplate` and
 * `resolveKeyedShape` are: `src/openapi/operation.ts` decides whether a query parameter it maps
 * gets an `omitWhen`, and it must reach exactly this answer or emit a spec these very refines
 * reject. A private copy there would be a restatement that can drift, and the direction that
 * drifts silently is the one where the copy is too permissive.
 *
 * The parameter is structural rather than `z.infer<typeof ArgSchema>` so a caller holding a
 * partially-built argument can ask. `optional` is compared to `true` rather than used for its
 * truthiness, which is identical for the schema's own output (where `.default(false)` makes it a
 * boolean) and correct for a caller whose field is absent.
 */
export function canOmitQueryValue(arg: {
  readonly optional?: boolean;
  readonly default?: string | number | boolean;
  readonly type: "string" | "number" | "boolean";
}): boolean {
  return arg.optional === true && arg.default === undefined && arg.type !== "boolean";
}

/**
 * One query-string parameter. `name` is the key as the API spells it and is deliberately not
 * an identifier check — `page[size]` is a real corpus key.
 *
 * `omitWhen` is an enum rather than a boolean because the guard it selects is one of two
 * specific predicates, not a yes/no: `"absent"` tests only `!== undefined` (circleci's
 * `pageToken`, github-actions's `branch`/`event`/`status`, github's `page`), `"empty"` adds
 * `&& !== ""` (discord/google-meet/google-photos's `after`/`pageToken`/`filter`). Both are
 * genuine author variance in the corpus — three connectors each way — not one canonical form
 * with an optional second clause, so a guarded entry must say which predicate it means; there
 * is no default between them. `omitWhen` itself stays optional — undefined means the entry is
 * set unconditionally, which is the third real shape (`limit`).
 */
export const QueryParamSchema = z.strictObject({
  name: z.string().min(1),
  arg: z.string().min(1),
  omitWhen: z.enum(["absent", "empty"]).optional(),
});

export type QueryParam = z.infer<typeof QueryParamSchema>;

/**
 * One rung of a conditional-endpoint ladder: the path to use when `absent` names an argument
 * that is `undefined`.
 *
 * `absent` reuses the word `QueryParamSchema.omitWhen` already uses for the identical test. A
 * second spelling for "this argument was not supplied" is the drift this repo removes.
 *
 * Deliberately NOT a general condition object. Every one of the twelve corpus connectors that
 * branches on an optional argument tests `=== undefined` and nothing else, and the single
 * compound guard (`semgrep`) means something a ladder cannot say — see docs/ROADMAP.md.
 */
export const PathWhenSchema = z.strictObject({
  absent: z.string().min(1),
  /**
   * Note the missing fourth argument, and that it is deliberate. `tools[].path` passes
   * `emptyIsMeaningful = true` because an empty `path` is already rejected by the checks that
   * read it, so adding a `.min(1)` there would move where an existing rejection comes from. No
   * such downstream check exists for a guard's path: `{ "absent": "x", "path": "" }` would emit a
   * guard returning the base URL alone. Defaulting to `false` gives it the `.min(1)`.
   */
  path: rawSplicedString(
    "tools[].pathWhen[].path",
    "the fetch helper's path argument template literal",
    "path-template",
  ),
});

export type PathWhen = z.infer<typeof PathWhenSchema>;

/**
 * A `"custom"` issue as the query checks below raise it: where it points, and what it says.
 * Those checks are module-level functions rather than blocks inside the superRefine, so they
 * take a sink instead of zod's refinement context — the `code: "custom"` is supplied by the
 * single call site that owns the context, and nothing else here names a zod issue type.
 */
type QueryIssue = { path: (string | number)[]; message: string };
type AddQueryIssue = (issue: QueryIssue) => void;

/**
 * renderPath (src/emit/server/path-template.ts) threads the query branch's prefix
 * (the fetch helper's base) straight into the template with no separator — it never
 * applies the leading-slash normalization renderFetchHelper's own `pathPart` guard
 * applies (src/emit/server/fetch-helper.ts). A path that already starts with "/" joins
 * cleanly; a path that does not silently fuses onto the base with nothing between them
 * (`https://x.testitems` instead of `https://x.test/items`) and the malformed URL is
 * only visible once the connector makes a request. Rejecting here, rather than teaching
 * renderPath the same normalization, keeps that guard in the one place
 * (fetch-helper.ts) that owns it.
 *
 * Guarded on t.path !== undefined: a "stub" tool has no "path" by construction (the
 * impl/path pairing refine above), and this check evaluated `""` as that stub's path
 * would fire alongside the "stub" + "query" rejection a few refines up — two issues for
 * one mistake, with the correct one buried under noise. The stub case is already
 * rejected there; this check has nothing to add for it.
 */
function checkQueryPathPrefix(name: string, path: string | undefined, add: AddQueryIssue): void {
  if (path !== undefined && !path.startsWith("/")) {
    add({
      path: ["path"],
      message:
        `tool ${JSON.stringify(name)} declares "query", so "path" must begin with "/" ` +
        `— got ${JSON.stringify(path)}`,
    });
  }
}

/** Which of canOmitQueryValue's three clauses an arg fails, phrased for the message below. */
function omitWhenViolations(arg: z.infer<typeof ArgSchema>): string[] {
  const violations: string[] = [];
  if (!arg.optional) violations.push('is not declared "optional": true');
  if (arg.default !== undefined) violations.push('declares a "default"');
  if (arg.type === "boolean") violations.push('is type "boolean"');
  return violations;
}

/** The two rules that read one query entry against the arg it names. */
function checkQueryEntryArg(
  q: QueryParam,
  arg: z.infer<typeof ArgSchema>,
  i: number,
  add: AddQueryIssue,
): void {
  // Comparing a number or boolean to "" is TS2367 in the generated package, and passing
  // that comparison's operand to `set` is TS2345 — compiled to confirm, not assumed.
  if (q.omitWhen === "empty" && arg.type !== "string") {
    add({
      path: ["query", i, "omitWhen"],
      message:
        `"query" entry ${JSON.stringify(q.name)} sets omitWhen: "empty", but arg ` +
        `${JSON.stringify(q.arg)} declares type ${JSON.stringify(arg.type)} — comparing ` +
        `a ${arg.type} to "" does not typecheck`,
    });
  }

  // omitWhen's guard only omits anything if the value it tests can genuinely be
  // undefined — canOmitQueryValue's exact predicate. Both directions of that question
  // are checked here, off the one predicate, so they cannot drift apart: no corpus
  // connector combines omitWhen with a dead guard (github writes
  // `String(parsed.perPage ?? 30)` unconditionally and guards `page`, which is optional
  // with no default and type number).
  if (q.omitWhen === undefined) {
    // A value that CAN be undefined and has no guard reaches searchParams.set
    // unconditionally: TS2345 for a string arg (set(key, value) rejects `string |
    // undefined`), and a literal "?<name>=undefined" on the wire for anything else,
    // since the non-string branch wraps in String(...) and String(undefined) ===
    // "undefined". Neither is visible to a spec author until the generated package is
    // built or the request is inspected — this rejection is what makes it visible here.
    if (canOmitQueryValue(arg)) {
      add({
        path: ["query", i, "omitWhen"],
        message:
          `"query" entry ${JSON.stringify(q.name)} names arg ${JSON.stringify(q.arg)}, ` +
          'which can be undefined ("optional": true, no "default", not type "boolean") ' +
          'but declares no "omitWhen" — set "omitWhen" to "absent" or "empty", or the ' +
          'parameter is sent as an unconditional (and possibly literal-"undefined") value',
      });
    }
  } else if (!canOmitQueryValue(arg)) {
    const violations = omitWhenViolations(arg).join(" and ");
    add({
      path: ["query", i, "omitWhen"],
      message:
        `"query" entry ${JSON.stringify(q.name)} sets omitWhen, but arg ` +
        `${JSON.stringify(q.arg)} ${violations} — its value can never be ` +
        "undefined, so the guard can never omit the parameter",
    });
  }
}

export const ToolSchema = z
  .strictObject({
    /**
     * Quoted almost everywhere it is emitted — and raw in one place, which is the whole reason
     * it is guarded: `renderMapping` (src/emit/wiring.ts) writes it into the `/** … *\/`
     * docstring of the generated `<name>-mapping.ts`, where a name ending in `_list` and
     * containing a block-comment terminator closes the docstring early and everything after it
     * is emitted as statements.
     */
    name: rawSplicedString(
      "tools[].name",
      "the Gateway wiring mapping stub's block comment",
      undefined,
    ),
    description: z.string().min(1),
    /**
     * An argument key reaches a declaration position only when the argument is HOISTED —
     * `claimHoistedArgs` (src/validate.ts) resolves the hoisted name as `arg.local ?? argName`,
     * so a key with a `default` or of type `"boolean"` becomes `const <key> = …`. Measured:
     * `{ "class": { "type": "string" } }` emits clean, `{ "class": { "type": "boolean" } }` is a
     * Biome parse error.
     *
     * The rule is applied FLAT anyway, which over-rejects the non-hoisted case on purpose. A
     * conditional rule would mean adding `"default": 1` to an argument that already validated
     * flips the whole spec to invalid — the argument `RESERVED_IDENTIFIERS` (src/validate.ts)
     * makes for itself three separate times, and it is stronger here, because the field that
     * would decide validity sits inside the same object as the name being judged.
     */
    args: z
      .record(
        identifierField(
          "argument name must be a valid JS identifier",
          "Rename the argument. Where the API spells the parameter this way, the wire spelling " +
            'is carried separately — by a "query" entry\'s "name", or by "body", which maps an ' +
            "argument key to the field name the request actually sends.",
        ),
        ArgSchema,
      )
      .default({}),
    /**
     * `renderPath` (src/emit/server/path-template.ts) splices every literal segment into a
     * template literal, escaping a backslash and a backtick as it goes — so those two are
     * neutralised at the splice site and this guard is the second line rather than the only
     * one. It is applied anyway, on `RAW_SPLICE_TERMINATORS`'s stated rule: the terminator set
     * belongs to the field, and the block-comment terminator is neutralised nowhere. A path is
     * the one carrier whose `${…}` is a documented DSL, so `parsePathTemplate` keeps that half
     * — see `SpliceInterpolation`.
     *
     * No `.min(1)` here, deliberately: `path` was `z.string().optional()` and an empty path is
     * already rejected by the checks that read it (a query tool's leading-`/` rule), so adding
     * one would move where an existing rejection comes from without changing what is accepted.
     */
    path: rawSplicedString(
      "tools[].path",
      "the fetch helper's path argument template literal",
      "path-template",
      true,
    ).optional(),
    query: z
      .array(QueryParamSchema)
      .min(1, "a query must declare at least one parameter")
      .optional(),
    /**
     * Guards evaluated in order before `path`, each selecting a different endpoint when its
     * named argument is absent. `path` remains the final unguarded return, so a spec without
     * `pathWhen` is unchanged in meaning and in emitted bytes.
     */
    pathWhen: z
      .array(PathWhenSchema)
      .min(1, "a pathWhen must declare at least one guard")
      .optional(),
    // "get" is the Stage A spelling. It became wrong the moment `method` existed, but
    // 0.2.2 is published, so it is normalised rather than rejected.
    impl: z
      .enum(["rest", "get", "stub", "search"])
      .default("rest")
      .transform((v) => (v === "get" ? "rest" : v)),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    /**
     * The author's declaration of intent, deliberately NOT derived from `method`.
     * Measured against the 94 connectors, method-derived HITL matches only 62 — dagster
     * POSTs GraphQL queries, ramp and wiz POST to exchange tokens.
     */
    effect: z.enum(["read", "write", "delete"]).default("read"),
    /** arg name -> API field name. Omitted means "the args object is the body". */
    body: z.record(z.string().min(1), z.string().min(1)).optional(),
    /**
     * Property plucked from the response envelope. Omitted means the response IS the array.
     *
     * An identifier, not a free string, because `renderSearchTool` (src/emit/server/search.ts)
     * splices it into three code positions in one line — `const <rows> = (root as { <rows>?:
     * unknown[] } | null)?.<rows>;`. An ordinary envelope key like `data-items` emits
     * `const data-items = …`, which fails as a Biome PARSE error against the generator's own
     * output rather than as a named spec error. `validateSpec` then checks it against every
     * claimed name — see `checkRowsIdentifier` there for why it is checked and not claimed.
     */
    rows: identifierField().optional(),
    /** Per-connector result cap. Corpus: 100 ×24, 200 ×12, 2000 ×2, 50 ×1. */
    maxLimit: z.number().int().positive().default(100),
    filter: SearchFilterSchema.optional(),
  })
  .refine((t) => (t.impl === "stub") === (t.path === undefined), {
    message:
      '"path" is required when "impl" is not "stub", and must be omitted when "impl" is "stub" ' +
      '— "impl" and "path" disagree',
  })
  .refine((t) => !(t.impl === "stub" && (t.method !== "GET" || t.body !== undefined)), {
    message: 'a "stub" tool issues no request, so "method" and "body" have nothing to describe',
  })
  .refine((t) => !(t.method === "GET" && t.effect !== "read" && t.impl !== "stub"), {
    message:
      'a GET tool cannot have effect "write" or "delete" — a REST GET that mutates is a bug, ' +
      "not a design. Set the method the API actually requires.",
  })
  .refine((t) => !(t.body !== undefined && t.method === "GET"), {
    message: '"body" requires a non-GET "method"',
  })
  // superRefine only, deliberately: a parallel .refine asserting the same condition would
  // fire alongside this one with a vaguer message, and the test asserts the offending key
  // name appears in the error. One check, one message, naming the key that is wrong.
  .superRefine((t, ctx) => {
    if (t.body === undefined) return;
    for (const k of Object.keys(t.body)) {
      if (!(k in t.args)) {
        ctx.addIssue({ code: "custom", message: `"body" key "${k}" is not a declared arg` });
      }
    }
  })
  .refine((t) => (t.impl === "search") === (t.filter !== undefined), {
    message:
      '"filter" is required when "impl" is "search", and is not valid on any other tool kind',
  })
  .refine((t) => !(t.impl === "search" && (t.method !== "GET" || t.body !== undefined)), {
    message: 'a "search" tool issues a GET, so "method" and "body" have nothing to describe',
  })
  .refine((t) => !(t.impl === "search" && t.effect !== "read"), {
    message:
      'a "search" tool cannot mutate — "effect" must be "read". Unlike a stub, it stands in ' +
      "for nothing that will later write.",
  })
  .refine((t) => t.impl === "search" || (t.rows === undefined && t.maxLimit === 100), {
    message: '"rows" and "maxLimit" are only valid on a tool with "impl": "search"',
  })
  .refine((t) => !(t.impl === "stub" && t.query !== undefined), {
    message: 'a "stub" tool issues no request, so "query" has nothing to describe',
  })
  // renderSearchTool (src/emit/server/tools-hand.ts) returns early for impl === "search" and
  // never reads t.query — accepted at parse time and then silently discarded at emit time,
  // the exact "accepted then discarded" failure this project has already fixed once (see
  // the omitWhen/needsExtractor checks above). rest-kit tools cannot be impl: "search" at
  // all (the schema's own rest-kit refine above rejects it), so this only ever fires for
  // hand-rolled or read-only-kit.
  .refine((t) => !(t.impl === "search" && t.query !== undefined), {
    message:
      'a "search" tool builds its query string from "filter", so "query" has nothing to describe',
  })
  .refine((t) => !(t.query !== undefined && (t.path ?? "").includes("?")), {
    message:
      '"query" and a "?" inside "path" both write the query string — use one. A tool that ' +
      'needs "query" moves its whole query string there.',
  })
  .superRefine((t, ctx) => {
    const add: AddQueryIssue = ({ path, message }) =>
      ctx.addIssue({ code: "custom", path, message });

    const guarded = new Set<string>();
    (t.pathWhen ?? []).forEach((g, i) => {
      // `t.args[g.absent]` reaches inherited properties (`"toString"` would find
      // Object.prototype's method rather than nothing), the same hazard the query loop below
      // guards with the same fix — Object.hasOwn checks only t.args's own keys.
      const arg = Object.hasOwn(t.args, g.absent) ? t.args[g.absent] : undefined;
      if (arg === undefined) {
        add({
          path: ["pathWhen", i, "absent"],
          message:
            `"pathWhen" guard ${String(i)} names arg ${JSON.stringify(g.absent)}, but the tool ` +
            "declares no such arg",
        });
        return;
      }
      // The same predicate query's omitWhen uses, called rather than restated: a guard on a value
      // that can never be undefined is dead code, and the two rules must not drift apart.
      if (!canOmitQueryValue(arg)) {
        add({
          path: ["pathWhen", i, "absent"],
          message:
            `"pathWhen" guard ${String(i)} tests arg ${JSON.stringify(g.absent)}, but that arg ` +
            `${omitWhenViolations(arg).join(" and ")} — its value can never be undefined, so the ` +
            "guard can never select its path",
        });
        return;
      }
      if (guarded.has(g.absent)) {
        add({
          path: ["pathWhen", i, "absent"],
          message:
            `"pathWhen" tests arg ${JSON.stringify(g.absent)} more than once — the second guard ` +
            "is unreachable, since the first returns whenever it is absent",
        });
      }
      guarded.add(g.absent);

      // POSITIONAL, not global. Guard i may reference any arg EXCEPT the one it tests: reaching
      // guard i means every earlier guard's test was false, so those args are non-undefined here.
      // The naive version — collect every guarded arg and reject any reference to any of them —
      // rejects athena_list, the shape this feature exists to reach.
      for (const seg of parsePathTemplate(g.path)) {
        if (seg.kind === "arg" && seg.name === g.absent) {
          add({
            path: ["pathWhen", i, "path"],
            message:
              `"pathWhen" guard ${String(i)}'s path interpolates ${JSON.stringify(g.absent)}, ` +
              'the arg it tests for absence — it would render "undefined" into the URL. A ' +
              "template literal accepts `string | undefined`, so the generated package compiles " +
              "and the wrong request is sent silently.",
          });
        }
      }
    });

    if (t.query === undefined) return;

    checkQueryPathPrefix(t.name, t.path, add);

    const seen = new Set<string>();
    for (const [i, q] of t.query.entries()) {
      // `q.arg in t.args` reaches inherited properties (`"toString"` would pass with an empty
      // `args: {}`), and the renderer would then emit a reference to `Object.prototype`'s
      // method instead of failing loudly. `Object.hasOwn` checks only t.args's own keys.
      const declared = Object.hasOwn(t.args, q.arg);
      if (!declared) {
        add({
          path: ["query", i, "arg"],
          message: `"query" entry ${JSON.stringify(q.name)} names arg ${JSON.stringify(q.arg)}, which the tool does not declare`,
        });
      }
      if (seen.has(q.name)) {
        add({
          path: ["query", i, "name"],
          message: `"query" declares ${JSON.stringify(q.name)} twice — the second would silently win`,
        });
      }
      seen.add(q.name);

      // The checks in checkQueryEntryArg are skipped when the arg itself is undeclared — the
      // "does not declare" issue above already covers that case, and `arg.type`/`arg.default`
      // would have nothing real to report on.
      if (!declared) continue;
      checkQueryEntryArg(q, t.args[q.arg]!, i, add);
    }
  });

export const EnvSchema = z
  .strictObject({
    vars: z.array(z.string().min(1)).min(1),
    /** Accessor function name. */
    local: identifierField(),
    /**
     * Internal variable name per var. Cosmetic; defaults to camelCase(var).
     *
     * An identifier for the same reason `local` is, and it was not one: `readLines`
     * (src/emit/server/env.ts) emits `const <binding> = process.env[…]?.trim();`, so a binding
     * of `t = ((): string => { … })(); const junk` emits a second declaration whose initializer
     * runs on every call to the accessor.
     */
    bindings: z.array(identifierField()).optional(),
    required: z.boolean().default(false),
    default: z.string().optional(),
    /**
     * How a trailing slash is stripped from a user-supplied base URL. The corpus splits 13
     * to 3 in favour of the helper — `"trimTrailingSlashFn"` emits the shared
     * `function trimTrailingSlash(s: string): string` once and calls it (airflow, argocd,
     * databricks, dbt, zendesk and 8 more), `"stripTrailingSlash"` inlines
     * `.replace(/\/$/, "")` (fastmail, grafana, sentry). Both are kept because the minority
     * form is byte-locked by the grafana and sentry fixtures, not because the split is
     * close. Byte-identical helper text in all 13, so it is a constant here rather than a
     * template.
     */
    transform: z.enum(["stripTrailingSlash", "trimTrailingSlashFn"]).optional(),
    /**
     * Text placed either side of the accessor's value, spliced RAW into `wrapped()`'s template
     * literal (src/emit/server/env.ts) — and, for `auth: "basic"`, into the username ARGUMENT
     * of `encodeBasicAuthHeader`, which is an expression position with no `return` in front of
     * it. Reproduced before this guard existed: a `prefix` of
     * `${(() => { globalThis.__PWNED__ = "yes"; return ""; })()}` on zendesk's basic entry
     * emitted that IIFE into the Authorization header built for every request. Both fields take
     * no interpolation of their own — no emitter rewrites a reference in either.
     */
    prefix: rawSplicedString(
      "env[].prefix",
      "the env accessor's value template, and the username argument to encodeBasicAuthHeader",
      undefined,
      true,
    ).optional(),
    suffix: rawSplicedString(
      "env[].suffix",
      "the env accessor's value template, and the username argument to encodeBasicAuthHeader",
      undefined,
      true,
    ).optional(),
    auth: z.enum(["bearer", "basic", "headers", "client-credentials"]).optional(),
    /** Header name per var, required when auth === "headers". */
    headerNames: z.array(z.string().min(1)).optional(),
    /**
     * Split a bearer accessor in two: a `(): string` accessor named by this field, which
     * reads and guards the variable, and `local`, reduced to a wrapper that builds the
     * header from a call to it — `function apiToken(): string` plus
     * `function authHeader(): Record<string, string>` returning `` `Bearer ${apiToken()}` ``.
     * Omitted keeps the single fused accessor, which is what newrelic/datadog/grafana/sentry
     * emit.
     *
     * **12** corpus connectors are byte-reproducible by this field. The membership rule is
     * narrower than "splits the accessor in two", and the difference matters — see
     * renderSplitBearer in src/emit/server/env.ts, which states the criterion and lists
     * them.
     */
    tokenLocal: identifierField().optional(),
    /**
     * Token endpoint, required when auth === "client-credentials".
     *
     * `z.url()` rather than the deprecated `z.string().url()`: in zod 4 the string-method
     * form is a deprecated alias for exactly this, same acceptance set and same
     * `invalid_format`/`format: "url"` issue, so the swap is a rename only.
     */
    tokenUrl: z.url().optional(),
    scope: z.string().min(1).optional(),
    /** ramp sends Basic; powerbi, looker and teams put client_secret in the body. */
    credentialsIn: z.enum(["basic", "body"]).optional(),
  })
  .refine((e) => !(e.required && e.default !== undefined), {
    message:
      'env entry cannot declare both "default" and "required" — a defaulted value is never empty',
  })
  /*
   * The one entry shape with no way to emit correct code: no `auth`, no `default`, and
   * `required` left at its schema default of `false`. `guardLines` (src/emit/server/env.ts)
   * emits nothing for it, so the accessor returns `process.env[…]?.trim()` — `string |
   * undefined` — out of a function `renderEnvAccessor` declares as `(): string`. It is the
   * shape an author gets by omitting fields, and no fixture has it, so no gate saw it.
   *
   * REFUSED rather than emitted differently, and that is the measured choice. All six shapes
   * that reach this branch were compiled under Nimbus's own compilerOptions, and each of the two
   * emitter fixes closes some of them and leaves the rest:
   *
   *   bare                   TS2322   return type `string`, expression `string | undefined`
   *   transform: strip…      TS18048  `zzUrl.replace(…)` on a possibly-undefined binding
   *   transform: trim…Fn     TS2345   `trimTrailingSlash(zzUrl)`
   *   prefix / suffix / both CLEAN, and wrong at runtime — the value lands in a template
   *                          literal, so the accessor returns the LITERAL TEXT "undefined" and
   *                          the fetch helper requests `https://undefined/…`
   *
   * Widening the return type to `string | undefined` fixes only the first row: the two
   * `transform` rows fail INSIDE the body, where the return type is not what is being checked,
   * and it turns the three clean rows into `string | undefined` at every `${env.X}` call site,
   * which is the same silent interpolation one level out. Coalescing the body (`?? ""`) does
   * typecheck all six, at the price of converting three loud failures into an empty URL
   * authority. Refusing costs no emitted byte at all — this rule touches no emitter — and it is
   * the only option that leaves nothing behind that compiles and is wrong.
   *
   * An optional variable is still expressible, and the message names the two spellings: give it
   * a `default`, which suppresses the guard and makes the binding `string`.
   */
  .refine((e) => e.auth !== undefined || e.default !== undefined || e.required, {
    message:
      'an env entry with no "auth" and no "default" must set "required": true — with no guard ' +
      "to narrow it, its accessor returns process.env[…]?.trim() unchanged, which is " +
      "`string | undefined`, from a function the emitter declares as `(): string`. The " +
      "generated package then fails its own typecheck (TS2322, or TS18048/TS2345 when " +
      '"transform" is set) — or, with "prefix"/"suffix", where the value is spliced into a ' +
      'template literal, it typechecks and returns the text "undefined" at runtime. Set ' +
      '"required": true, or give the variable a "default".',
  })
  .refine((e) => e.bindings === undefined || e.bindings.length === e.vars.length, {
    message: '"bindings" must have exactly one entry per "vars" entry',
  })
  // Within ONE entry, not across entries: `readLines` emits `const <binding> = …` once per var
  // into a single accessor body, so two vars sharing a binding emit two `const`s of that name in
  // one block — the generator failing against its own output instead of with a named spec error.
  // Two DIFFERENT entries may share a binding freely; each is a separate function scope, and
  // several fixtures do (bindings: ["t"] appears in twelve of them).
  .refine((e) => e.bindings === undefined || new Set(e.bindings).size === e.bindings.length, {
    message:
      '"bindings" repeats a name — each var in one entry is read into its own const in the ' +
      "same accessor body, so two vars cannot share one",
  })
  .refine((e) => e.auth !== "headers" || e.headerNames?.length === e.vars.length, {
    message: '"headerNames" must have one entry per "vars" entry when auth is "headers"',
  })
  // "basic" is the exception, and only for prefix/suffix: those decorate the USERNAME
  // passed to encodeBasicAuthHeader (zendesk's `${email}/token`), a position the wrapper
  // does not replace. `transform` has no such position and stays rejected for every mode.
  .refine(
    (e) =>
      e.auth === undefined ||
      (e.transform === undefined &&
        (e.auth === "basic" || (e.prefix === undefined && e.suffix === undefined))),
    {
      message:
        'an entry with "auth" cannot also declare "transform", "prefix" or "suffix" — the auth wrapper replaces the returned value (auth: "basic" may declare "prefix"/"suffix", which decorate the username)',
    },
  )
  .refine(
    (e) =>
      e.vars.length === 1 ||
      e.auth === "basic" ||
      e.auth === "headers" ||
      e.auth === "client-credentials",
    {
      message:
        'only an entry with auth: "basic", auth: "headers" or auth: "client-credentials" may declare multiple "vars"',
    },
  )
  .refine((e) => e.auth !== "basic" || e.vars.length === 2, {
    message: 'auth: "basic" requires exactly two "vars" — a username and a password',
  })
  .refine((e) => e.auth !== "client-credentials" || e.vars.length === 2, {
    message: 'auth: "client-credentials" requires exactly two "vars" — a client id and a secret',
  })
  .refine((e) => e.auth !== "client-credentials" || e.tokenUrl !== undefined, {
    message: '"tokenUrl" is required when auth is "client-credentials"',
  })
  .refine((e) => e.auth !== "client-credentials" || e.credentialsIn !== undefined, {
    message: '"credentialsIn" is required when auth is "client-credentials"',
  })
  .refine((e) => e.tokenUrl === undefined || e.auth === "client-credentials", {
    message: '"tokenUrl" is only valid when auth is "client-credentials"',
  })
  .refine((e) => e.scope === undefined || e.auth === "client-credentials", {
    message: '"scope" is only valid when auth is "client-credentials"',
  })
  .refine((e) => e.credentialsIn === undefined || e.auth === "client-credentials", {
    message: '"credentialsIn" is only valid when auth is "client-credentials"',
  })
  .refine((e) => e.tokenLocal === undefined || e.auth === "bearer", {
    message:
      '"tokenLocal" is only valid when auth is "bearer" — it names the raw-token accessor the ' +
      "bearer header wrapper calls, and no other auth mode emits one",
  })
  .refine((e) => e.tokenLocal === undefined || e.tokenLocal !== e.local, {
    message:
      '"tokenLocal" must differ from "local" — the two name two functions declared in the ' +
      "same module",
  });

export const FetchHelperSchema = z
  .strictObject({
    local: identifierField(),
    /** Template over ${env.X}, e.g. "https://api.newrelic.com" or "https://${env.siteHost}". */
    base: rawSplicedString(
      "fetchHelper.base",
      "the fetch helper's URL template literal",
      RESOLVED_ENV_REF,
    ),
    /**
     * Hoist `base` to a module-scope `const <name> = "<base>";` and reference that const
     * from the emitted helper(s) instead of inlining the literal. mercury spells it `BASE`,
     * bitrise `BITRISE_API`. Omitted inlines the literal, which is what
     * newrelic/datadog/grafana/sentry do.
     */
    baseConst: identifierField().optional(),
    /**
     * Name of an env accessor returning the header record.
     *
     * An identifier, because `headerOption` (src/emit/server/fetch-helper.ts) emits it as a CALL
     * — `headers: <name>()` — with nothing between the spec string and the emitted expression.
     * A value of `((): Record<string, string> => { globalThis.__PWNED__ = "x"; return headers();
     * })` emitted an IIFE the fetch helper invokes on every request, and it typechecked.
     */
    headers: identifierField().optional(),
    /** Literal header object, values may reference ${env.X}. Mutually exclusive with `headers`. */
    inlineHeaders: z.record(z.string(), z.string()).optional(),
    normalizeLeadingSlash: z.boolean().default(false),
    jsonFallbackRaw: z.boolean().default(false),
    /**
     * How a fully-static path renders in a fetch-helper call. A per-connector convention:
     * 17 corpus connectors quote it, 8 use a backtick template literal, none mix.
     */
    staticPathStyle: z.enum(["quoted", "template"]).default("quoted"),
  })
  // A `${env.X}` reference resolves to an accessor CALL, and the const is initialised at
  // module scope, before the process env has been guarded — hoisting it would move the
  // accessor's throw from the first request to import time, and freeze a value the
  // accessor is written to recompute. Only a fully static base may be hoisted.
  .refine((f) => f.baseConst === undefined || !/\$\{env\./.test(f.base), {
    message:
      '"baseConst" requires a fully static "base" — a base naming ${env.X} resolves to an ' +
      "accessor call, which must not run at module-initialisation time",
  })
  // The "accepted then discarded" class, on the one field where the discarded thing is a
  // CREDENTIAL — see isEnvRefHeaderValue, which is the emitter's own predicate rather than a
  // copy of it. An anchored value keeps working; a value with no ${ at all is a plain header
  // and is untouched; only the mixed form is refused, and it is refused because there is no
  // spelling of it the emitter honours.
  .superRefine((f, ctx) => {
    for (const [name, value] of Object.entries(f.inlineHeaders ?? {})) {
      if (!value.includes("${") || isEnvRefHeaderValue(value)) continue;
      ctx.addIssue({
        code: "custom",
        path: ["inlineHeaders", name],
        message:
          `inline header ${JSON.stringify(name)} mixes text with an interpolation ` +
          `(${JSON.stringify(value)}). The emitter resolves a value that is exactly ` +
          '"${env.NAME}" and JSON-quotes everything else, so this one is emitted as those ' +
          "literal characters and sent on the wire verbatim — for an Authorization header, " +
          "the credential is never read. Move the surrounding text into the env accessor " +
          '(env[].prefix / env[].suffix) and leave "${env.NAME}" alone here.',
      });
    }
  });

/**
 * The two styles that emit their own fetch helper and env accessors. `read-only-kit`
 * differs from `hand-rolled` only in the server file's prologue and epilogue — its import
 * group, and the `runReadOnlyMcpConnector` wrapper the registrations sit inside instead of
 * the McpServer/StdioServerTransport wiring. Neither touches how arguments, env, headers or
 * the fetch helper are declared, so every schema rule keyed to "hand-rolled" applies to it
 * unchanged.
 */
function isHandStyle(style: string): boolean {
  return style === "hand-rolled" || style === "read-only-kit";
}

export const ConnectorSpecSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9-]+$/, "name must be lower-kebab-case"),
    title: z.string().min(1).optional(),
    displayName: z.string().min(1),
    id: z.string().min(1).optional(),
    description: z.string().min(1),
    serviceLabel: rawSplicedString(
      "serviceLabel",
      "an emitted error message's template literal and a block comment in the Gateway wiring",
      undefined,
    ),
    style: z.enum(["rest-kit", "hand-rolled", "read-only-kit"]).default("rest-kit"),
    /**
     * How a REST tool's handler is written. `"concise"` is an expression-bodied arrow
     * (`async () => jsonResult(await nrGet(...))`), the form newrelic/datadog/grafana/
     * sentry use; `"block"` is a statement body with an explicit `return`, which 57 of the
     * 60 corpus connectors built on `runReadOnlyMcpConnector` use. A per-connector
     * convention like `fetchHelper.staticPathStyle`, and it never mixes within a connector.
     * A stub or search handler always has a block body and is unaffected.
     */
    handlerStyle: z.enum(["concise", "block"]).default("concise"),
    /**
     * How a tool's `z.object({...})` argument schema is printed: on one line, or one field
     * per line. Biome preserves whichever the emitter produces, so it is the emitter's
     * choice rather than the formatter's. `z.object({})` is always one line — an empty
     * object has nothing to break onto.
     */
    argsSchemaStyle: z.enum(["inline", "expanded"]).default("inline"),
    network: z.array(z.string()).default([]),
    /**
     * The manifest's `permissions.filesystem`, emitted after `network` when declared. 29 of
     * the 94 corpus manifests carry it — most, like zendesk, as a pair of empty arrays
     * stating explicitly that the connector touches no files. Omitted leaves the key out
     * entirely, which is what the other 65 do, so the existing fixtures cannot move.
     */
    filesystem: z
      .strictObject({
        read: z.array(z.string()).default([]),
        write: z.array(z.string()).default([]),
      })
      .optional(),
    syncInterval: z.number().int().positive().default(300),
    minNimbusVersion: z.string().default("0.2.0"),
    env: z.array(EnvSchema).default([]),
    fetchHelper: FetchHelperSchema,
    tools: z.array(ToolSchema).default([]),
  })
  .refine(
    (s) =>
      !isHandStyle(s.style) ||
      (s.fetchHelper.headers === undefined) !== (s.fetchHelper.inlineHeaders === undefined),
    {
      message:
        "a hand-rolled connector must declare exactly one of fetchHelper.headers or fetchHelper.inlineHeaders",
    },
  )
  .refine(
    (s) =>
      s.style !== "rest-kit" ||
      (s.fetchHelper.headers === undefined &&
        s.fetchHelper.normalizeLeadingSlash === false &&
        s.fetchHelper.jsonFallbackRaw === false),
    {
      message:
        'fetchHelper.headers, .normalizeLeadingSlash and .jsonFallbackRaw apply only to style "hand-rolled" — the rest-kit helper ignores them',
    },
  )
  .refine(
    (s) =>
      s.style !== "rest-kit" ||
      (s.env.length === 1 && s.env[0]?.auth === "bearer" && s.env[0]?.vars.length === 1),
    {
      message:
        'a rest-kit connector must declare exactly one env entry, with auth: "bearer" and a single var — makeRestToolRegistrar resolves the token itself and no env accessors are emitted',
    },
  )
  // Not a validate.ts identifier claim, because the colliding names are not spec-authored:
  // renderTokenFunction emits `cachedToken` and `token` at module scope, hard-coded, once per
  // client-credentials entry. Two entries emit each name twice. Nothing in the corpus has two
  // token exchanges, and supporting them would mean parameterising those names — a change to
  // emitted shape for a case no connector has, so this is rejected instead.
  .refine((s) => s.env.filter((e) => e.auth === "client-credentials").length <= 1, {
    message:
      'a connector may declare at most one env entry with auth: "client-credentials" — the ' +
      "emitted token exchange declares `token` and `cachedToken` at module scope, so a second " +
      "entry would redeclare both",
  })
  .refine((s) => s.style !== "rest-kit" || !s.env.some((e) => e.auth === "client-credentials"), {
    message:
      'style "rest-kit" cannot use client-credentials: makeRestToolRegistrar resolves a single ' +
      'bearer credential itself and has no seam for a token exchange. Use style "hand-rolled".',
  })
  .refine(
    (s) =>
      s.style !== "rest-kit" ||
      (!/\$\{env\./.test(s.fetchHelper.base) &&
        Object.values(s.fetchHelper.inlineHeaders ?? {}).every((v) => !/\$\{env\./.test(v))),
    {
      message:
        "a rest-kit connector cannot reference ${env.X} in fetchHelper.base or fetchHelper.inlineHeaders — rest-kit emits no env accessors, so the call would be undefined",
    },
  )
  // Measured: the intersection of the 10 rest-tool-kit users and the 45 mcp-search-tool
  // users in the corpus is empty, and the code explains why — makeRestToolRegistrar
  // performs the fetch AND wraps the result, so there is no callback between the response
  // and the MCP result for the filter to run in. Same shape as the client-credentials
  // exclusion above.
  .refine((s) => s.style !== "rest-kit" || !s.tools.some((t) => t.impl === "search"), {
    message:
      'style "rest-kit" cannot declare an "impl": "search" tool: makeRestToolRegistrar ' +
      "performs the request and wraps the result itself, so it has no seam for the filter. " +
      'Use style "read-only-kit" or "hand-rolled".',
  })
  // One emitted `export const` per filter, all in one src/search-filter.ts. Two tools
  // naming the same export would emit a duplicate declaration. No corpus connector reuses
  // one filter across two search tools (raindrop's two are distinct exports).
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    for (const t of s.tools) {
      const name = t.filter?.export;
      if (name === undefined) continue;
      if (seen.has(name)) {
        ctx.addIssue({
          code: "custom",
          message:
            `two tools declare "filter.export": "${name}" — each search tool emits its own ` +
            "export into src/search-filter.ts, so the names must differ",
        });
      }
      seen.add(name);
    }
  });

export type EnvSpec = z.infer<typeof EnvSchema>;
export type ToolSpec = z.infer<typeof ToolSchema>;
export type ArgSpec = z.infer<typeof ArgSchema>;
export type FetchHelperSpec = z.infer<typeof FetchHelperSchema>;

/**
 * `fetchHelper.staticPathStyle`'s two values, derived from the schema rather than restated — it
 * appeared as an inline `"quoted" | "template"` at eleven sites across src/emit and src/derive
 * when this alias was introduced (measured 2026-08-06), which was eleven places for the schema to
 * be widened and one of them to be missed.
 *
 * That eleven is a HISTORICAL count and no command reproduces it — the change that motivated the
 * alias is what removed the sites. The figure that stays checkable is the current one, and it only
 * grows: `grep -rn "StaticPathStyle" src/` reports 27 lines as of 2026-08-07 (20 use sites, six
 * imports, and this declaration). The field carries `.default("quoted")`, so `z.infer`'s output is
 * already the non-optional union — `NonNullable` would be noise (verified: both forms compile
 * identically).
 */
export type StaticPathStyle = z.infer<typeof FetchHelperSchema>["staticPathStyle"];

export type ConnectorSpec = z.infer<typeof ConnectorSpecSchema> & {
  readonly title: string;
  readonly id: string;
};

/** Capitalise the first letter only: "newrelic" -> "Newrelic". Matches the README fixtures. */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The PascalCase identifier fragment every emitted name built from `title` is derived from —
 * `register<X>Tool`, `create<X>Syncable`, `map<X>ItemToItem`, `<X>SearchMatchOptions`.
 *
 * Exported and shared because it was restated at three call sites and TWO of them stripped.
 * `src/emit/search-filter.ts` spliced `title` in raw, so the ordinary two-word title every
 * hyphenated connector defaults to — `capitalize("google-meet")` is `"Google-meet"` — emitted
 * `export type Google-meetSearchMatchOptions`, and the generator failed with a Biome PARSE
 * error against its own output. No search fixture has a multi-word title, which is why every
 * gate stayed green; `google-meet`, `google-photos` and `github-actions` are exactly the corpus
 * connectors a future search fixture would come from.
 *
 * `validateSpec` checks the RESULT is a usable identifier — stripping cannot rescue a title
 * whose first character is a digit, and it can produce the empty string.
 */
export function titleIdentifier(title: string): string {
  return title.replaceAll(/[^A-Za-z0-9]/g, "");
}

/** Module-scope registrar constant emitted for `style: "rest-kit"` connectors. */
export function registrarName(spec: ConnectorSpec): string {
  return `register${titleIdentifier(spec.title)}Tool`;
}

function preflightOutOfScope(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  const tools = (input as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return;
  for (const t of tools) {
    if (typeof t !== "object" || t === null) continue;
    for (const [key, why] of Object.entries(OUT_OF_SCOPE_TOOL_KEYS)) {
      if (key in t) {
        throw new Error(`"${key}" is not a supported tool field: ${why}.`);
      }
    }
  }
}

/**
 * Render an issue's path the way a human editing spec JSON by hand reads it: dotted keys,
 * bracketed array indices — `tools[0].args.limit`, never `tools.0.args.limit`, in which the `0`
 * could be an array position or an object key literally named `"0"`. JSON Pointer (`/tools/0/…`)
 * makes the same distinction unambiguous for a machine; this string is for the person who wrote
 * the JSON, so brackets read closer to how they typed the array index than a slash would.
 *
 * The first segment gets NO leading dot, and that arm needs an ANCHORED assertion to be tested
 * at all: dropping it yields `.tools[0].args.limit.max`, which still CONTAINS
 * `tools[0].args.limit.max`, so every unanchored `toContain`/`toMatch` in test/spec.test.ts
 * stayed green when it was mutated out. The assertions that guard it match `/^ {2}…/` against a
 * line, pinning the indent the line actually starts with.
 *
 * Module-private: `parseSpec` below is its only caller. An export is a contract, and this one
 * has no second consumer.
 */
function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else {
      out += out.length === 0 ? String(seg) : `.${String(seg)}`;
    }
  }
  return out;
}

/**
 * Walk the RAW input (before Zod applies defaults or transforms) by an issue's own path, so the
 * error line can show what was actually rejected there rather than only where. This reads the
 * caller's input directly instead of Zod's own per-issue `input` (available via `{ reportInput:
 * true }`) because that field reports the value at the schema level the issue's check RAN at —
 * for a `superRefine` on `ToolSchema` that adds an issue at a relative path like
 * `["query", 0, "arg"]`, Zod's `input` is the whole tool object, not the query entry's `arg`
 * string. Re-resolving the issue's full (already-absolute) `path` against the original input
 * lands on the same specific value for every issue kind, built-in or custom — verified against
 * both in a scratch script before writing this.
 */
function valueAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let cur = input;
  for (const seg of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

/**
 * How much of a rejected value an error line shows.
 *
 * A root-level issue has an EMPTY path, so the value at it is the whole spec: an unrecognized
 * top-level key printed the entire file back on one line — 387 characters for the smallest spec
 * this repo's tests use, 3,169 for `fixtures/dependencytrack.spec.json`, and unbounded for a
 * spec a user wrote. The received value is here to identify what was rejected, not to reproduce
 * it, and 120 characters is well past every scalar a spec writes (a `name`, a `local`, a `base`)
 * while cutting an object dump down to something that still reads as one line.
 */
const RECEIVED_MAX_CHARS = 120;

/**
 * The `(…)` half of an error line: what was at the issue's path, rendered as JSON.
 *
 * The `undefined` branch is not a defensive shrug. `JSON.stringify` returns `undefined` — the
 * value, not the string — for everything JSON cannot represent, and a MISSING REQUIRED KEY is
 * exactly that case, and the commonest failure in a hand-written spec. Interpolated, it printed
 * the bare token `undefined`: the one rendering on these lines that is not a JSON literal,
 * sitting where `"ten"`, `null` and `42` all appear as themselves. It says so in words instead.
 */
function formatReceived(input: unknown, path: readonly PropertyKey[]): string {
  const json = JSON.stringify(valueAtPath(input, path));
  if (json === undefined) return "no JSON value there — usually a missing key";
  const shown = json.length > RECEIVED_MAX_CHARS ? `${json.slice(0, RECEIVED_MAX_CHARS)}…` : json;
  return `received ${shown}`;
}

/**
 * The message an issue carries — or, for a record KEY rejection, the messages of the checks the
 * key actually failed.
 *
 * zod 4 wraps a key-schema failure in an `invalid_key` issue whose own message is the generic
 * "Invalid key in record", with the real ones nested in its `issues` array. Only one field has a
 * key schema (`tools[].args`), and everything that field's rule has to say was landing in that
 * nested array and going nowhere: `{ "data-items": … }` reported "Invalid key in record" and not
 * "argument name must be a valid JS identifier", which pre-dates the reserved-word rule by every
 * release this schema has had. Unwrapped here rather than at the key schema, because the
 * flattening is Zod's and one line at the formatter is the whole of it.
 */
function issueMessage(issue: z.core.$ZodIssue): string {
  if (issue.code !== "invalid_key" || issue.issues.length === 0) return issue.message;
  return issue.issues.map((nested) => nested.message).join("; ");
}

export function parseSpec(input: unknown): ConnectorSpec {
  preflightOutOfScope(input);
  const parsed = ConnectorSpecSchema.safeParse(input);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  ${formatIssuePath(i.path)}: ${issueMessage(i)} (${formatReceived(input, i.path)})`,
    );
    throw new Error(`Invalid connector spec:\n${lines.join("\n")}`);
  }
  const s = parsed.data;
  return { ...s, title: s.title ?? capitalize(s.name), id: s.id ?? `com.nimbus.${s.name}` };
}
