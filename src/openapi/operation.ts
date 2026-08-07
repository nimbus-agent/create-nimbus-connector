/**
 * One OpenAPI operation → one connector tool.
 *
 * The reader (`./document.ts`) says what the document *contains*; this says what of it this
 * generator can *emit*. Those are different questions, and the gap between them is where every
 * refusal below lives: a header parameter, a form-encoded body and an `array` argument are all
 * perfectly valid OpenAPI that the spec language in `src/spec.ts` has no shape for.
 *
 * Three rules govern the whole file, and each has bitten this project before:
 *
 * 1. **An operation maps completely or is refused.** A partial map — a tool missing the one
 *    parameter that could not be expressed — is a connector that compiles, passes every gate and
 *    sends the wrong request. `mapOperation` therefore collects and returns EVERY refusal rather
 *    than the first, so one run names every construct standing in the way instead of turning
 *    into a sequence of one-at-a-time discoveries.
 * 2. **Refuse by name.** Every refusal carries a `kind` naming the construct, and a `detail`
 *    naming the operation, so `--from-openapi` can print something a user can act on. The kinds:
 *
 *      operation-shape             an `Operation` whose `raw` is not an object
 *      path-not-absolute           a path that does not begin with "/"
 *      path-templating             a templating form other than OpenAPI's `{name}`
 *      undeclared-path-parameter   a `{name}` in the path that no parameter declares
 *      unused-path-parameter       an `in: "path"` parameter the template never mentions
 *      parameter-shape             a `parameters` that is not an array, or a malformed entry
 *      parameter-location          `in: "header"` or `in: "cookie"` (or anything else)
 *      schema-shape                a schema node whose modelled field carries the wrong type
 *      schema-type                 a type the spec language has no equivalent for, or none
 *      schema-composition          `oneOf` / `anyOf` / `allOf`
 *      schema-default              a `default` that is not a scalar of the argument's own type
 *      media-type                  a request body offering no `application/json` (or `+json`)
 *      request-body-shape          a request body that is not a flat object with `properties`
 *      nested-request-body         a body property that is not a scalar
 *      body-on-get                 a GET carrying a request body
 *      argument-name               a parameter name no slug can make a JS identifier
 *      argument-name-collision     two names slugifying onto one argument
 *      reserved-argument-name      a slug landing on `RESERVED_IDENTIFIERS`, or on a JavaScript
 *                                  reserved word
 * 3. **Order is bytes.** `src/emit/server/args.ts` iterates `Object.entries(args)`, and
 *    `renderBodyExpr` builds its default body from `Object.keys(tool.args)`, so the order
 *    arguments are inserted here is the field order of the emitted `z.object({ … })` and of the
 *    emitted `JSON.stringify({ … })`. Every ordering decision below is therefore stated, not
 *    incidental: parameters before body properties, path-item parameters before the operation's
 *    own, an override in the position it overrode, and document order within each group.
 *
 * **What this deliberately does not decide.** No `effect` — an OpenAPI document carries nothing
 * that answers it, and the corpus is emphatic that deriving HITL from the HTTP method is wrong
 * for a third of connectors, so a non-GET operation carries a note asking for it instead.
 * No `description` when the operation supplies no `summary`; Task 3 owns the `TODO:` placeholder
 * for that, and `notes` is what it folds into the description it writes.
 *
 * **On `$ref` siblings.** `resolveRefs` replaces a referenced node whole, dropping any
 * `summary`/`description` sibling, and its docstring calls that acceptable *because no mapper
 * reads them*. That still holds, and the checkable form of the claim is: every schema-node field
 * this file reads is DECLARED in `OpenApiSchemaNodeSchema`, and that schema declares no
 * documentation field — no `description`, no `summary`, no `title` — at any depth. Reading the
 * one schema is therefore enough to re-verify the condition, which a list restated here would
 * only invite going stale.
 */
import { canOmitQueryValue, isReservedWord } from "../spec.ts";
import { RESERVED_IDENTIFIERS } from "../validate.ts";
import type { Operation } from "./document.ts";
import {
  type OpenApiDocument,
  OpenApiMediaTypeSchema,
  OpenApiOperationDetailSchema,
  OpenApiParameterSchema,
  OpenApiRequestBodySchema,
  type OpenApiSchemaNode,
  OpenApiSchemaNodeSchema,
} from "./schema.ts";

export type MappedTool = {
  /** A tool object for `ToolSchema`. Task 3 folds it into a spec and parses the whole thing. */
  tool: Record<string, unknown>;
  /** Human-facing TODO fragments Task 3 folds into the tool's description string. */
  notes: string[];
};

export type Refusal = { kind: string; detail: string };

export type MappedOperation = { ok: true; mapped: MappedTool } | { ok: false; refusals: Refusal[] };

/** The identifier rule `ToolSchema` enforces on `args` keys, restated here to check against. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const RESERVED = new Set(RESERVED_IDENTIFIERS);

/** OpenAPI path templating, and nothing else: one `{name}` with no braces inside it. */
const PATH_VARIABLE = /\{([^{}]*)\}/g;

/**
 * What may appear between those braces. Deliberately narrow: RFC 6570 gives `{+id}`, `{#id}`,
 * `{?a,b}` and more meaning, OpenAPI gives them none, and a slug would quietly turn `{+id}` into
 * the argument `id` — dropping an operator that changes how the value is expanded.
 */
const PATH_VARIABLE_NAME = /^[A-Za-z0-9_.-]+$/;

/** Express's `/:id`, which is neither OpenAPI's form nor this generator's. */
const EXPRESS_PLACEHOLDER = /\/:[A-Za-z_]/;

const SCALAR_TYPES: Record<string, { type: "string" | "number" | "boolean"; int?: true }> = {
  string: { type: "string" },
  number: { type: "number" },
  integer: { type: "number", int: true },
  boolean: { type: "boolean" },
};

/** The two types that make a request body nested rather than flat. */
const NESTED_TYPES = new Set(["object", "array"]);

/** One argument as `ArgSchema` spells it, with every field that matches a default left out. */
type ArgDecl = {
  type: "string" | "number" | "boolean";
  optional?: true;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  int?: true;
};

/**
 * Everything one `mapOperation` call accumulates.
 *
 * A shared sink rather than a return value per helper, because rule 1 above needs every refusal
 * from every stage in one list: a helper that returned its first refusal would stop the stage it
 * is in, and the operation's other four problems would surface one run at a time.
 */
type Collected = {
  readonly where: string;
  readonly refusals: Refusal[];
  readonly notes: string[];
};

/** Every refusal goes through here, so the operation can never be named in only some of them. */
function refuse(c: Collected, kind: string, detail: string): undefined {
  c.refusals.push({ kind, detail: `${c.where}: ${detail}` });
  return undefined;
}

function note(c: Collected, text: string): void {
  c.notes.push(text);
}

/* ------------------------------------------------------------------------------------------ *
 * Argument names
 * ------------------------------------------------------------------------------------------ */

/**
 * An OpenAPI parameter or property name as a JS identifier, or `undefined` when no slug can be.
 *
 * `ToolSchema` constrains `args` keys with `/^[A-Za-z_$][A-Za-z0-9_$]*$/`, and `{widget-id}`,
 * `{widget.id}` and `page[size]` are all ordinary in real documents. Slugifying rather than
 * refusing is LOSSLESS, which is the whole justification: the argument name is spec-internal and
 * never reaches the wire. A path template interpolates the *value* at that segment's position, a
 * query entry carries the API's own spelling in its `name`, and a request body carries it in the
 * `body` mapping — so the request is byte-identical whichever name the spec uses, and refusing
 * would cost real reach for a name nobody observes.
 *
 * A name that is ALREADY an identifier is returned untouched rather than re-cased, so the common
 * case cannot drift. What is left after separators are removed must itself be an identifier: a
 * leading digit (`2fa`) is refused rather than decorated with a prefix, because a prefix is a
 * name the document does not contain and this is the one place where inventing one would be
 * invisible to the author.
 */
function slugifyArgName(documentName: string): string | undefined {
  if (IDENTIFIER.test(documentName)) return documentName;
  const parts = documentName.split(/[^A-Za-z0-9]+/).filter((p) => p !== "");
  if (parts.length === 0) return undefined;
  const slug =
    parts[0] +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("");
  return IDENTIFIER.test(slug) ? slug : undefined;
}

/* ------------------------------------------------------------------------------------------ *
 * The path
 * ------------------------------------------------------------------------------------------ */

/**
 * The template variables in a path, in the order they appear — or `undefined` when the path could
 * not be read at all, refusing every form that is not OpenAPI's `{name}`.
 *
 * Every check here refuses rather than passing through, and the reason is the same one
 * `src/spec.ts`'s `FOREIGN_PLACEHOLDER` gives: a placeholder this generator does not interpolate
 * is emitted as literal path characters, and the connector then requests a URL containing
 * `{widgetId}`. That compiles, typechecks and passes every gate. Nothing fails until the
 * connector is pointed at a real API.
 *
 * **`undefined` is not the same as `[]`, and conflating them stated something false.** An
 * unreadable path yields no variables, and `checkPathParameterAgreement` reading that as "the
 * template names nothing" then told the user that every correctly declared `in: "path"` parameter
 * was one "the path template never names". `"widgets/{widgetId}"` reproduced it exactly:
 * `["path-not-absolute", "unused-path-parameter"]`, the second of which invites deleting a
 * parameter that is right. So an unreadable path returns `undefined` and the caller skips the
 * agreement check.
 *
 * The signal is "did THIS function refuse", measured off the shared sink rather than a flag set
 * per branch. That is deliberate: a refusal added here later cannot forget to opt in, which a
 * per-branch `return undefined` could — and did, in the partial-list branches below, where the
 * first version returned the names it had managed to collect.
 */
function readPathVariables(path: string, c: Collected): string[] | undefined {
  const before = c.refusals.length;

  if (!path.startsWith("/")) {
    refuse(
      c,
      "path-not-absolute",
      `a path must begin with "/" — the fetch helper joins it onto the base URL with no ` +
        `separator, so "${path}" would fuse onto the host.`,
    );
    return undefined;
  }
  if (path.includes("${")) {
    refuse(
      c,
      "path-templating",
      `this path already contains "\${", which is this generator's own placeholder syntax, not ` +
        "OpenAPI's. It cannot be told apart from a template this mapper wrote.",
    );
    return undefined;
  }
  if (EXPRESS_PLACEHOLDER.test(path)) {
    refuse(
      c,
      "path-templating",
      "this path uses Express-style `/:name` segments. OpenAPI templating is `{name}`, and a " +
        "`:name` segment would be sent as literal path characters.",
    );
    return undefined;
  }

  const names: string[] = [];
  for (const match of path.matchAll(PATH_VARIABLE)) {
    const name = match[1] ?? "";
    if (!PATH_VARIABLE_NAME.test(name)) {
      refuse(
        c,
        "path-templating",
        `"${match[0]}" is not an OpenAPI template expression. Only "{name}" is, and an RFC 6570 ` +
          "operator changes how the value expands rather than naming a different parameter.",
      );
      continue;
    }
    names.push(name);
  }
  const residue = path.replaceAll(PATH_VARIABLE, "");
  if (residue.includes("{") || residue.includes("}")) {
    refuse(c, "path-templating", `"${path}" has an unbalanced brace outside any {name}.`);
  }
  return c.refusals.length === before ? names : undefined;
}

// `/widgets/{widget-id}` -> `/widgets/${arg.widgetId|enc}`.
//
// `|enc` is the default mode, and it is the one place in this file that encodes a CORPUS
// convention rather than a fact the document states: 59 of the 94 corpus connectors
// percent-encode at least one path argument, measured at tree 94fd3623. Re-measure from
// packages/mcp-connectors with:
//
//     grep -l encodeURIComponent */src/server.ts | wc -l
//
// The majority is decisive, and the two failure modes are asymmetric: encoding a value that
// needed no encoding changes nothing for the identifiers these segments carry, while NOT
// encoding one that needed it produces a malformed URL for any id holding a slash or a space.
//
// Only ever called once an operation has no refusals, so every variable has a slug by here.
//
// `slugFor` is built with `new Map(parameters.map(p => [p.documentName, p.slug]))`, which assumes
// document names are UNIQUE across the operation as well as present — two parameters sharing one
// would silently keep the last. That is unreachable today only INCIDENTALLY: one document name
// slugifies to one slug, so a repeat is already an `argument-name-collision`. The assumption is
// therefore load-bearing on that refusal, not on anything local. Relaxing the collision rule (see
// claimArgument, which records that the refusal is a choice rather than a necessity) means giving
// this map a real key — the `(name, in)` pair — in the same change.
function renderSpecPath(path: string, slugFor: ReadonlyMap<string, string>): string {
  return path.replaceAll(
    PATH_VARIABLE,
    (_whole, name: string) => `\${arg.${slugFor.get(name)}|enc}`,
  );
}

/* ------------------------------------------------------------------------------------------ *
 * Parameters, and OpenAPI's merge rule
 * ------------------------------------------------------------------------------------------ */

type ParameterIdentity = { name: string; location: string };

/** A parameter's `(name, in)` pair, or `undefined` when it has neither — see `mergeParameters`. */
function parameterIdentity(value: unknown): ParameterIdentity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { name, in: location } = value as { name?: unknown; in?: unknown };
  if (typeof name !== "string" || typeof location !== "string") return undefined;
  return { name, location };
}

/**
 * OpenAPI's override test, written as the two comparisons it actually is.
 *
 * Deliberately NOT a composite string key. Joining the pair needs a separator that can appear
 * in neither half, and choosing one wrong is a bug that surfaces only on the one document whose
 * parameter name contains it — a silent wrong answer in the exact place this rule exists to
 * prevent one.
 */
function sameParameter(a: ParameterIdentity, b: ParameterIdentity): boolean {
  return a.name === b.name && a.location === b.location;
}

/**
 * The path item's `parameters` and the operation's own, merged on OPENAPI's rule — implemented
 * here rather than re-derived, because the rule has a trap in it.
 *
 * A path-level parameter applies to every operation in the item, and an operation-level parameter
 * OVERRIDES it when both `name` **and** `in` match. Matching on `name` alone is wrong: the same
 * name may legally appear once in `path` and once in `query`, and collapsing those two would
 * silently drop the path declaration — leaving a `{widgetId}` in the template with nothing
 * declaring it, or, worse, an argument sent to the wrong half of the URL.
 *
 * An override replaces the path-level entry IN PLACE. Order is emitted bytes (see this file's
 * header), so the alternative — dropping the inherited entry and appending the override — would
 * mean that adding an override to a document reorders the generated tool's argument schema. A
 * parameter with no readable `(name, in)` can match nothing and is appended; `mapParameters`
 * refuses it by shape a moment later.
 */
function mergeParameters(pathLevel: readonly unknown[], own: readonly unknown[]): unknown[] {
  const merged = [...pathLevel];
  for (const parameter of own) {
    const identity = parameterIdentity(parameter);
    const at =
      identity === undefined
        ? -1
        : merged.findIndex((m) => {
            const other = parameterIdentity(m);
            return other !== undefined && sameParameter(other, identity);
          });
    if (at >= 0) merged[at] = parameter;
    else merged.push(parameter);
  }
  return merged;
}

/** The operation's own `parameters`, or `[]` — a non-array is refused by shape, not coerced. */
function readOwnParameters(parameters: unknown, c: Collected): unknown[] {
  if (parameters === undefined) return [];
  if (!Array.isArray(parameters)) {
    return (
      refuse(
        c,
        "parameter-shape",
        `an operation's "parameters" must be an array, found ${typeof parameters}.`,
      ) ?? []
    );
  }
  return parameters;
}

type MappedParameter = {
  readonly slug: string;
  readonly documentName: string;
  readonly location: "path" | "query";
  readonly arg: ArgDecl;
};

/**
 * Every merged parameter this generator can express, in merged order.
 *
 * Continues past a refusal deliberately — the point of collecting is that an operation with a
 * header parameter AND an array parameter names both in one run.
 */
function mapParameters(merged: readonly unknown[], c: Collected): MappedParameter[] {
  const out: MappedParameter[] = [];
  for (const raw of merged) {
    const mapped = mapOneParameter(raw, c);
    if (mapped !== undefined) out.push(mapped);
  }
  return out;
}

/**
 * One merged parameter, or `undefined` once it has been refused — every `continue` the loop above
 * used to carry, which is what put each of these guards a level deep for no reason: the decision
 * is about ONE parameter, and collecting the results is the loop's whole remaining job.
 */
function mapOneParameter(raw: unknown, c: Collected): MappedParameter | undefined {
  const parsed = OpenApiParameterSchema.safeParse(raw);
  if (!parsed.success) {
    refuse(c, "parameter-shape", `a parameter is not a parameter object (${issuesOf(parsed)}).`);
    return undefined;
  }
  const parameter = parsed.data;
  const where = `parameter "${parameter.name}"`;

  if (parameter.in !== "path" && parameter.in !== "query") {
    refuse(
      c,
      "parameter-location",
      `${where} is declared in: "${parameter.in}". A generated tool sends only path and query ` +
        "parameters — the fetch helper owns every header it sends, and no tool sends cookies.",
    );
    return undefined;
  }
  if (parameter.schema === undefined) {
    refuse(
      c,
      "parameter-shape",
      parameter.content === undefined
        ? `${where} declares no "schema", so its type is unknown.`
        : `${where} is content-encoded ("content" rather than "schema"), which serialises the ` +
            "value as a media type this generator does not build.",
    );
    return undefined;
  }

  const slug = slugifyArgName(parameter.name);
  if (slug === undefined) {
    refuse(
      c,
      "argument-name",
      `${where} cannot become a JS identifier, which a spec argument name must be. Rename it ` +
        "in the document, or add the argument by hand after generating.",
    );
    return undefined;
  }
  if (slug !== parameter.name) {
    note(
      c,
      `TODO: the argument "${slug}" is the document's "${parameter.name}", renamed because a ` +
        "spec argument name must be a valid JS identifier. The request is unchanged.",
    );
  }

  // A path parameter is required whatever the document says: the URL cannot be built without a
  // value, and an optional one would emit encodeURIComponent(string | undefined), which is a
  // TS2345 in the generated package rather than a runtime surprise.
  const required = parameter.in === "path" || parameter.required === true;
  if (parameter.in === "path" && parameter.required !== true) {
    note(
      c,
      `TODO: path parameter "${parameter.name}" is not marked required in the document; it is ` +
        "mapped as a required argument, because the URL cannot be built without a value.",
    );
  }

  const arg = mapScalarSchema(parameter.schema, where, required, undefined, c);
  if (arg === undefined) return undefined;
  return { slug, documentName: parameter.name, location: parameter.in, arg };
}

/**
 * One `query` entry per query parameter.
 *
 * `omitWhen` is set exactly when `canOmitQueryValue` says the value can genuinely be `undefined`,
 * and left off otherwise, where `ToolSchema` rejects it as a guard that can never fire. That
 * predicate is IMPORTED from `src/spec.ts` rather than restated: the schema uses the same function
 * to reject both a missing guard and a dead one, so a local copy here could drift into emitting a
 * spec those refines reject — or, worse, agree with them today and stop agreeing silently.
 *
 * `"absent"` rather than `"empty"`: the document says nothing about empty strings, and `"empty"`
 * is the strictly stronger claim (it drops `""` as well), so choosing it would assert something
 * the document does not.
 */
function queryEntry(p: MappedParameter): Record<string, unknown> {
  return canOmitQueryValue(p.arg)
    ? { name: p.documentName, arg: p.slug, omitWhen: "absent" }
    : { name: p.documentName, arg: p.slug };
}

/* ------------------------------------------------------------------------------------------ *
 * Schema nodes
 * ------------------------------------------------------------------------------------------ */

function issuesOf(parsed: { error: { issues: readonly { message: string }[] } }): string {
  return parsed.error.issues.map((i) => i.message).join("; ");
}

/**
 * One scalar schema node as an `ArgSchema` declaration, or `undefined` once it has been refused.
 *
 * `nestedKind` is the refusal a NON-scalar type earns, and it differs by caller because the two
 * cases are genuinely different constructs. An `array` query PARAMETER is not "nested" — it is a
 * type the spec language lacks, so it earns `schema-type`. A request-body PROPERTY carrying its
 * own `properties`, or typed `object`/`array`, is the non-flat body this mapper cannot flatten,
 * so it earns `nested-request-body`. Collapsing the two into one kind would make the message
 * wrong for whichever case lost.
 */
function mapScalarSchema(
  node: unknown,
  where: string,
  required: boolean,
  nestedKind: string | undefined,
  c: Collected,
): ArgDecl | undefined {
  const parsed = OpenApiSchemaNodeSchema.safeParse(node);
  if (!parsed.success) {
    return refuse(c, "schema-shape", `${where} has an unreadable schema (${issuesOf(parsed)}).`);
  }
  const schema = parsed.data;

  const composed = ["oneOf", "anyOf", "allOf"].filter(
    (k) => (schema as Record<string, unknown>)[k] !== undefined,
  );
  if (composed.length > 0) {
    return refuse(
      c,
      "schema-composition",
      `${where} uses ${composed.join("/")}. A tool argument is one value of one type, and there ` +
        "is no branch in the generated schema for a value that could be either.",
    );
  }

  const scalar = typeof schema.type === "string" ? SCALAR_TYPES[schema.type] : undefined;
  if (scalar === undefined) {
    const nested =
      nestedKind !== undefined &&
      (schema.properties !== undefined ||
        (typeof schema.type === "string" && NESTED_TYPES.has(schema.type)));
    return refuse(
      c,
      nested ? nestedKind : "schema-type",
      schema.type === undefined
        ? `${where} declares no type, so there is nothing to generate an argument from.`
        : `${where} declares type ${JSON.stringify(schema.type)}, which has no equivalent among ` +
            'the spec language\'s "string", "number" and "boolean".',
    );
  }

  const arg: ArgDecl = { type: scalar.type };
  if (!required) arg.optional = true;
  if (!applyDefault(schema, arg, where, required, c)) return undefined;
  applyBounds(schema, arg, where, c);
  if (scalar.int === true) arg.int = true;

  if (typeof schema.format === "string") {
    note(
      c,
      `TODO: ${where} declares format "${schema.format}", which the spec language does not ` +
        "carry — the generated schema does not check it.",
    );
  }
  if (Array.isArray(schema.enum)) {
    note(
      c,
      `TODO: ${where} accepts only ${schema.enum.map((v) => JSON.stringify(v)).join(", ")} in ` +
        "the document; the spec language has no enum, so the generated schema accepts any value.",
    );
  }
  applyUncarried(schema, where, c);
  return arg;
}

/**
 * Constraint keywords `ArgSchema` has no field for, reported rather than dropped in silence.
 *
 * `format` and `enum` above are the same class and already get a note each; these were the ones
 * that did not, which made the rule "a constraint the generated schema will not enforce is
 * reported" true of two keywords and false of seven. One sweep instead of seven branches, so a
 * keyword added to the list cannot be added without its note.
 *
 * `readOnly` earns a second, sharper note. The others make the generated schema LOOSER than the
 * document — it accepts values the API will reject, which the caller finds out from the API.
 * `readOnly: true` on a request-body property is different in kind: the API rejects the field
 * itself on a write, so the tool is offering an argument that cannot be sent at all.
 */
const UNCARRIED_KEYWORDS = [
  "pattern",
  "minLength",
  "maxLength",
  "multipleOf",
  "nullable",
  "readOnly",
  "writeOnly",
] as const;

function applyUncarried(schema: OpenApiSchemaNode, where: string, c: Collected): void {
  const node = schema as Record<string, unknown>;
  const present = UNCARRIED_KEYWORDS.filter((k) => node[k] !== undefined);
  if (present.length > 0) {
    note(
      c,
      `TODO: ${where} declares ${present.join(", ")}, which the spec language does not carry — ` +
        "the generated schema does not enforce them.",
    );
  }
  if (schema.readOnly === true) {
    note(
      c,
      `TODO: ${where} is readOnly in the document, so the API rejects it on a write. The ` +
        "generated tool offers it as an argument a caller can set — remove it, or the request " +
        "fails whenever it is used.",
    );
  }
}

/**
 * `default` onto an argument, or a refusal. Returns whether mapping may continue.
 *
 * Two kinds of default are dropped rather than carried, and both are `ArgSchema` refines rather
 * than judgement calls: a boolean's default is ignored by the emitted hoist
 * (`renderHoists` writes `p.x === true ? "true" : "false"`, which never consults it), and a
 * required argument's default can never be reached because the schema demands a value. Both are
 * noted, because a dropped default is a difference between the document and the connector.
 */
function applyDefault(
  schema: OpenApiSchemaNode,
  arg: ArgDecl,
  where: string,
  required: boolean,
  c: Collected,
): boolean {
  if (!Object.hasOwn(schema, "default")) return true;
  const value = schema.default;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    refuse(
      c,
      "schema-default",
      `${where} declares a default of ${JSON.stringify(value)}, which is not a string, a number ` +
        "or a boolean — the only three a spec argument can hold.",
    );
    return false;
  }
  if (typeof value !== arg.type) {
    refuse(
      c,
      "schema-default",
      `${where} is type "${arg.type}" but declares a ${typeof value} default ` +
        `(${JSON.stringify(value)}). The emitted hoist would put that value where the argument's ` +
        "own type belongs, which does not typecheck.",
    );
    return false;
  }
  if (arg.type === "boolean") {
    note(
      c,
      `TODO: ${where} declares a default, which is dropped — the generated hoist for a boolean ` +
        'argument emits `=== true ? "true" : "false"` and never reads one.',
    );
    return true;
  }
  if (required) {
    note(
      c,
      `TODO: ${where} declares a default, which is dropped — the argument is required, so the ` +
        "schema demands a value and the default can never be reached.",
    );
    return true;
  }
  arg.default = value;
  return true;
}

/** One end of a numeric range: the inclusive bound to emit, and whether the document meant `>`. */
/**
 * One end of a numeric range: the inclusive bound to emit, and whether emitting it LOSES the
 * document's `>` — which is the fact `applyBounds`'s note asserts.
 *
 * The field is named for that fact rather than for the input that produces it, and the rename is
 * the fix for a real defect rather than a tidy-up. It was `exclusive`, meaning "an exclusive
 * keyword was present", while the note it gated claimed "the generated schema accepts the boundary
 * value the document excludes". For `{minimum: 10, exclusiveMinimum: 5}` the first is true and the
 * second is false — `x >= 10` already implies `x > 5`, so `z.number().min(10)` is exact — and the
 * note said something untrue about the document. A flag named for the input reads as correct at
 * every call site; one named for the claim does not.
 */
type Bound = { value: number | undefined; widened: boolean };

/**
 * One bound as `ArgSchema` can express it, which is INCLUSIVE and only inclusive.
 *
 * Both OpenAPI dialects reach here, because `assertSupportedVersion` accepts any 3.x. OpenAPI
 * **3.0** spells `> 5` as `minimum: 5` with the boolean `exclusiveMinimum: true`; **3.1** (JSON
 * Schema 2020-12) spells it as the number `exclusiveMinimum: 5`. Reading only `minimum` — which
 * is what this did first — turned `> 5` into `>= 5` with nothing said, so the generated tool
 * accepted a value the document says the API rejects. That is a spec whose constraint
 * CONTRADICTS its source, which is worse than one that merely fails to carry it.
 *
 * Where both a numeric `exclusiveMinimum` and a `minimum` are present, every keyword in a schema
 * must hold, so the tighter of the two is the effective bound. That is JSON Schema's own
 * semantics, not an approximation invented here — which is why `tighter` is passed in
 * (`Math.max` for a lower bound, `Math.min` for an upper one) rather than assumed.
 *
 * **`widened` follows which side WON, not which keywords were present.** The emitted number is
 * correct in every combination; only the note can be wrong, and it is wrong precisely when the
 * inclusive side is the binding one. A tie counts as widened — `x >= 5 && x > 5` is `x > 5`, so
 * emitting `min(5)` does lose the `>`.
 *
 * The boolean arm carries the same rule in its degenerate form: 3.0's `exclusiveMinimum: true`
 * MODIFIES `minimum`, so with no `minimum` beside it there is no bound to emit and nothing to
 * widen. That leaves the invariant this function's caller relies on — `widened` is true only when
 * `value` is a number.
 */
function inclusiveBound(
  inclusive: number | undefined,
  exclusive: boolean | number | undefined,
  tighter: (a: number, b: number) => number,
): Bound {
  if (typeof exclusive === "number") {
    const value = inclusive === undefined ? exclusive : tighter(inclusive, exclusive);
    return { value, widened: value === exclusive };
  }
  return { value: inclusive, widened: exclusive === true && inclusive !== undefined };
}

/**
 * `minimum`/`maximum` onto a numeric argument, widened from exclusive where necessary.
 *
 * Carried only for a number, because `ArgSchema`'s `min`/`max` emit `z.string().min(n)` on a
 * string — a LENGTH constraint, where OpenAPI's `minimum` is a numeric bound — and are rejected
 * outright on a boolean by the schema's own refine. Silently turning a value bound into a length
 * bound would generate a schema that rejects valid input, so the pair is dropped with a note.
 *
 * An exclusive bound is mapped and NOTED rather than refused, matching how `enum` and `format`
 * are handled two functions up: all three make the generated schema looser than the document, and
 * refusing an operation over an off-by-one bound would cost more reach than the looseness costs
 * correctness — `exclusiveMinimum: 0` for "a positive number" is ordinary in real documents. The
 * note is what stops it being silence. Widening to `>= 6` for an integer would be exact, and is
 * deliberately not done: it is a bound the document does not state, and it would be right for
 * `integer` and wrong for `number`.
 */
function applyBounds(schema: OpenApiSchemaNode, arg: ArgDecl, where: string, c: Collected): void {
  const min = inclusiveBound(schema.minimum, schema.exclusiveMinimum, Math.max);
  const max = inclusiveBound(schema.maximum, schema.exclusiveMaximum, Math.min);
  // `widened` implies `value !== undefined` (see inclusiveBound), so there is nothing to report
  // about a node that produced neither bound.
  if (min.value === undefined && max.value === undefined) return;
  if (arg.type !== "number") {
    note(
      c,
      `TODO: ${where} declares minimum/maximum, which are dropped — the spec language's ` +
        `"min"/"max" bound a number's value, and mean something else on a string (its length) ` +
        "or nothing at all on a boolean.",
    );
    return;
  }
  if (min.value !== undefined) arg.min = min.value;
  if (max.value !== undefined) arg.max = max.value;
  if (min.widened || max.widened) {
    const which = [min.widened ? "exclusiveMinimum" : "", max.widened ? "exclusiveMaximum" : ""]
      .filter((s) => s !== "")
      .join(" and ");
    note(
      c,
      `TODO: ${where} declares ${which}, and the spec language's "min"/"max" are INCLUSIVE — the ` +
        "generated schema accepts the boundary value the document excludes. Move the bound by " +
        "one, or drop it.",
    );
  }
}

/* ------------------------------------------------------------------------------------------ *
 * The request body
 * ------------------------------------------------------------------------------------------ */

/** A media type with its parameters stripped, so `application/json; charset=utf-8` matches. */
function normalizeMediaType(raw: string): string {
  return (raw.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * The first `application/json` or `application/…+json` key, or `undefined`.
 *
 * Explicit selection, not first-wins: a body offering `application/x-www-form-urlencoded`,
 * `multipart/form-data` or `text/*` is a DIFFERENT REQUEST this generator cannot emit, not a
 * formatting difference. `renderBodyExpr` writes `JSON.stringify(...)` and the fetch helper
 * sends `Content-Type: application/json`, so taking the first key regardless would produce a
 * connector that sends JSON to an endpoint that parses form fields — a 400 at best.
 */
function selectJsonMediaType(keys: readonly string[]): string | undefined {
  return keys.find((key) => {
    const type = normalizeMediaType(key);
    return (
      type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"))
    );
  });
}

type MappedProperty = {
  readonly slug: string;
  readonly documentName: string;
  readonly arg: ArgDecl;
};

/** The flat JSON request body's properties, in document order, or `[]` when there is no body. */
function mapBody(requestBody: unknown, method: string, c: Collected): MappedProperty[] {
  if (requestBody === undefined) return [];
  if (method === "GET") {
    refuse(
      c,
      "body-on-get",
      'this GET declares a requestBody. "body" requires a non-GET method in the spec language, ' +
        "and the generated fetch helper sends no body on a read.",
    );
    return [];
  }

  const parsed = OpenApiRequestBodySchema.safeParse(requestBody);
  if (!parsed.success) {
    refuse(c, "request-body-shape", `the requestBody is unreadable (${issuesOf(parsed)}).`);
    return [];
  }
  const content = parsed.data.content ?? {};
  const offered = Object.keys(content);
  if (offered.length === 0) {
    refuse(c, "media-type", "the requestBody declares no content, so there is no body to send.");
    return [];
  }
  const mediaType = selectJsonMediaType(offered);
  if (mediaType === undefined) {
    refuse(
      c,
      "media-type",
      `the requestBody offers ${offered.join(", ")} and no JSON media type. A generated tool ` +
        "sends JSON.stringify(...) with Content-Type: application/json, so that is a different " +
        "request rather than a different spelling of this one.",
    );
    return [];
  }

  const media = OpenApiMediaTypeSchema.safeParse(content[mediaType]);
  if (!media.success || media.data.schema === undefined) {
    refuse(c, "request-body-shape", `the ${mediaType} body declares no schema.`);
    return [];
  }
  return mapBodyProperties(media.data.schema, c);
}

function mapBodyProperties(rootSchema: unknown, c: Collected): MappedProperty[] {
  const parsed = OpenApiSchemaNodeSchema.safeParse(rootSchema);
  if (!parsed.success) {
    refuse(c, "schema-shape", `the request body schema is unreadable (${issuesOf(parsed)}).`);
    return [];
  }
  const root = parsed.data;
  const composed = ["oneOf", "anyOf", "allOf"].filter(
    (k) => (root as Record<string, unknown>)[k] !== undefined,
  );
  if (composed.length > 0) {
    refuse(
      c,
      "schema-composition",
      `the request body uses ${composed.join("/")}. A tool sends one body of one shape, and ` +
        "there is no branch in the emitted JSON.stringify for a body that could be either.",
    );
    return [];
  }
  if (typeof root.type === "string" && root.type !== "object") {
    refuse(
      c,
      "request-body-shape",
      `the request body is type ${JSON.stringify(root.type)}. A generated tool sends an object ` +
        "built from its own arguments, so only an object body has fields to map arguments onto.",
    );
    return [];
  }
  if (root.properties === undefined) {
    refuse(
      c,
      "request-body-shape",
      "the request body declares no properties, so there are no fields to turn into arguments.",
    );
    return [];
  }

  const requiredNames = new Set(root.required ?? []);
  const out: MappedProperty[] = [];
  // Object.entries, because a request body's `properties` is an object and argument order is
  // emitted order — see this file's header. `OpenApiSchemaNodeSchema` models it with z.record
  // for exactly this reason.
  for (const [documentName, node] of Object.entries(root.properties)) {
    const where = `request body property "${documentName}"`;
    const slug = slugifyArgName(documentName);
    if (slug === undefined) {
      refuse(
        c,
        "argument-name",
        `${where} cannot become a JS identifier, which a spec argument name must be.`,
      );
      continue;
    }
    if (slug !== documentName) {
      note(
        c,
        `TODO: the argument "${slug}" is the document's body field "${documentName}", renamed ` +
          'because a spec argument name must be a valid JS identifier. The tool\'s "body" ' +
          "mapping keeps the field name the API expects, so the request is unchanged.",
      );
    }
    const arg = mapScalarSchema(
      node,
      where,
      requiredNames.has(documentName),
      "nested-request-body",
      c,
    );
    if (arg === undefined) continue;
    out.push({ slug, documentName, arg });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------------------------------ */

/**
 * One argument into the tool's `args`, refusing a name that is taken or reserved.
 *
 * Both refusals exist because the alternative is silent. Two names slugifying onto one would drop
 * an argument, and the tool would then send one value where the API expects two. A slug landing
 * on a `RESERVED_IDENTIFIERS` entry produces a spec that fails this project's own `validateSpec`,
 * which is strictly worse than a refusal naming the parameter.
 *
 * A slug that is a JavaScript RESERVED WORD is the same failure a field over, and it arrives by
 * the one route `slugifyArgName` cannot see: `class`, `default`, `in`, `for` and `new` are already
 * valid identifiers by that function's regex, so they are returned untouched and never slugified.
 * Refused here on the same terms as its neighbour, and NOT auto-suffixed — the same choice, made
 * for the same reason, as the collision arm below argues for itself. A rename would be lossless
 * (the `query` entry carries the document's spelling) and it is the option to revisit if reach
 * ever justifies it; what rules it out today is that a suffix is a name the document does not
 * contain, and the refusal names the parameter the author actually wrote.
 *
 * **The collision refusal is a CHOICE, and the conservative one.** It also catches a shape that is
 * legal OpenAPI — the same name once `in: "path"` and once `in: "query"` — and that case could be
 * disambiguated instead, on the same argument that justifies slugifying at all: the argument name
 * is spec-internal, the `query` entry carries the document's own spelling, and the path template
 * carries the position, so a suffixed second name would emit a byte-identical request plus a
 * `TODO:` note. It is refused today because a refusal that names both sources is easier to act on
 * than a renamed argument nobody asked for. Two things move with that decision if it is ever
 * revisited: `renderSpecPath`'s `slugFor` map is keyed by document name and would need the
 * `(name, in)` pair instead, and the suffixing rule would itself have to stay injective.
 */
function claimArgument(
  args: Record<string, ArgDecl>,
  owners: Map<string, string>,
  slug: string,
  owner: string,
  arg: ArgDecl,
  c: Collected,
): void {
  if (RESERVED.has(slug)) {
    refuse(
      c,
      "reserved-argument-name",
      `${owner} maps onto the argument name "${slug}", which the emitter itself declares at ` +
        "module scope (RESERVED_IDENTIFIERS in src/validate.ts). Rename it in the document.",
    );
    return;
  }
  if (isReservedWord(slug)) {
    refuse(
      c,
      "reserved-argument-name",
      `${owner} maps onto the argument name "${slug}", which is a JavaScript reserved word and ` +
        "cannot be written in the `const` a hoisted argument declares. Rename it in the document.",
    );
    return;
  }
  const prior = owners.get(slug);
  if (prior !== undefined) {
    refuse(
      c,
      "argument-name-collision",
      `${prior} and ${owner} both map onto the argument name "${slug}". Merging them would drop ` +
        "one, and the tool would send one value where the API expects two.",
    );
    return;
  }
  owners.set(slug, owner);
  args[slug] = arg;
}

/**
 * The path template and the declared path parameters must name the same set.
 *
 * Both directions are checked, and neither is pedantry. A `{widgetId}` nothing declares would
 * force this mapper to invent a type — the exact failure `Operation.pathParameters` exists to
 * prevent — and an `in: "path"` parameter the template never mentions would become an argument
 * the generated tool declares, prompts a caller for, and never sends anywhere.
 *
 * **One cause, one refusal, in BOTH directions** — the discipline this function's first version
 * claimed while applying it only one way:
 *
 * - `declared` comes from the MERGED list rather than from the successfully mapped parameters, so
 *   a path parameter already refused for some other reason does not also earn an
 *   `undeclared-path-parameter`;
 * - and the caller does not run this at all when `readPathVariables` returned `undefined`, so a
 *   path that could not be READ does not make every parameter under it look unused.
 */
function checkPathParameterAgreement(
  variables: readonly string[],
  merged: readonly unknown[],
  c: Collected,
): void {
  const declared = new Set<string>();
  for (const parameter of merged) {
    const identity = parameterIdentity(parameter);
    if (identity?.location === "path") declared.add(identity.name);
  }
  for (const name of new Set(variables)) {
    if (declared.has(name)) continue;
    refuse(
      c,
      "undeclared-path-parameter",
      `the path template names "{${name}}", but no parameter declares it — neither the operation ` +
        "nor its path item. Its type would have to be invented.",
    );
  }
  for (const name of declared) {
    if (variables.includes(name)) continue;
    refuse(
      c,
      "unused-path-parameter",
      `parameter "${name}" is declared in: "path", but the path template never names it. It ` +
        "would become an argument the generated tool asks for and never sends.",
    );
  }
}

/**
 * One operation, as a tool object plus the notes a human needs to finish it — or every reason it
 * could not be mapped.
 *
 * `doc` is part of the interface Task 3 calls through and is deliberately not read: `loadDocument`
 * has already resolved every internal `$ref`, so a single operation carries everything its own
 * mapping needs. It is named with a leading underscore rather than dropped so the call site does
 * not have to change if a later mapping does need the document root.
 */
export function mapOperation(op: Operation, _doc: OpenApiDocument): MappedOperation {
  const c: Collected = { where: `${op.method} ${op.path}`, refusals: [], notes: [] };

  const detail = OpenApiOperationDetailSchema.safeParse(op.raw);
  if (!detail.success) {
    // listOperations cannot produce this — it parses every operation it lists — but `Operation`
    // is an exported type, so a hand-built one must refuse rather than throw a TypeError.
    refuse(c, "operation-shape", `the operation is not an object (${issuesOf(detail)}).`);
    return { ok: false, refusals: c.refusals };
  }

  const variables = readPathVariables(op.path, c);
  const merged = mergeParameters(op.pathParameters, readOwnParameters(detail.data.parameters, c));
  const parameters = mapParameters(merged, c);
  const properties = mapBody(detail.data.requestBody, op.method, c);
  // Skipped when the path could not be read: the agreement check compares against the set of
  // variables the template names, and an unreadable template has no such set — only an absence
  // that would be reported as "the template never names it" about parameters that are correct.
  if (variables !== undefined) checkPathParameterAgreement(variables, merged, c);

  const args: Record<string, ArgDecl> = {};
  const owners = new Map<string, string>();
  for (const p of parameters) {
    claimArgument(args, owners, p.slug, `${p.location} parameter "${p.documentName}"`, p.arg, c);
  }
  for (const p of properties) {
    claimArgument(args, owners, p.slug, `body property "${p.documentName}"`, p.arg, c);
  }

  if (c.refusals.length > 0) return { ok: false, refusals: c.refusals };

  if (op.method !== "GET") {
    note(
      c,
      `TODO: this ${op.method} is mapped with no "effect", which means "read" — so the manifest ` +
        'asks for no confirmation before it runs. Set "effect" to "write" or "delete" if it ' +
        "mutates; the document cannot say.",
    );
  }

  const description = op.summary?.trim() ?? "";
  const query = parameters.filter((p) => p.location === "query").map(queryEntry);
  // The body mapping is emitted whenever the operation has one, even where every argument name
  // already matches its field: it is the only thing that keeps the API's own spelling once a
  // name has been slugified, and one shape is easier to read than two. `renderBodyExpr` emits
  // identical bytes either way for the matching case — an explicit mapping and the default both
  // produce one pair per property, in this order.
  const body = Object.fromEntries(properties.map((p) => [p.slug, p.documentName]));

  const tool: Record<string, unknown> = {
    name: op.operationId,
    ...(description === "" ? {} : { description }),
    path: renderSpecPath(op.path, new Map(parameters.map((p) => [p.documentName, p.slug]))),
    ...(op.method === "GET" ? {} : { method: op.method }),
    args,
    ...(query.length === 0 ? {} : { query }),
    ...(properties.length === 0 ? {} : { body }),
  };
  return { ok: true, mapped: { tool, notes: c.notes } };
}
