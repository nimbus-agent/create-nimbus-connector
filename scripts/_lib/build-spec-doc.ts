/**
 * `docs/SPEC.md` — every field `ConnectorSpecSchema` accepts — and the single function that
 * produces it.
 *
 * Split out of scripts/build-spec-doc.ts for the two reasons scripts/_lib/build-schema.ts's header
 * gives, and they apply here unchanged. test/spec-doc.test.ts byte-compares the checked-in page
 * against a fresh build, and that comparison is worth nothing if the test regenerates by a
 * different route than the script writes by: both import `buildSpecDoc` AND `SPEC_DOC_PATH` from
 * here, so neither the bytes nor their destination can diverge. And a driver no test imports never
 * enters the coverage report, where an inlined `import.meta.main` block would.
 *
 * ## Why it is built from `buildSchema()`'s bytes rather than from a second `z.toJSONSchema` call
 *
 * The same hazard, one level up. A page reconstructed by its own call into zod would agree with
 * `schema/connector-spec.schema.json` only for as long as the two calls were passed the same
 * options — and `{ io: "input" }` versus `{ unrepresentable: "any" }` is not a detail: the two
 * describe different documents (see build-schema.ts's header). Parsing the published bytes means
 * the page and the schema cannot describe different languages, because there is one document.
 *
 * ## What is derived, what is written, and what happens when they disagree
 *
 * Everything structural is derived: which fields exist, their types, which are required, their
 * defaults, and every constraint keyword the schema carries. The one-line gloss per field in
 * `GLOSSES` is hand-written — no zod field carries a `.describe()`, so there is nothing to derive
 * it from — and it is held to the schema in BOTH directions: a field with no gloss and a gloss
 * naming no field each fail the build, and therefore the drift test. So a new spec field cannot
 * reach `docs/SPEC.md` as a blank row, and a removed one cannot leave its prose behind.
 *
 * A gloss says what a field IS. It does not restate a refinement, and that boundary is the whole
 * reason this file does not try to be complete: see `DOC_LIMITATION` below.
 *
 * ## Nothing is dropped silently
 *
 * `assertEveryKeywordRendered` sweeps the whole document at build time and throws on a keyword
 * neither rendered nor deliberately consumed, and `renderType` throws on a shape it does not model
 * rather than printing a placeholder. Both exist because the alternative failure is invisible: a
 * page that quietly omits the constraint zod grew last week still builds, still byte-matches its
 * own generator, and is wrong in the one direction a reader cannot detect.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchema, SCHEMA_LIMITATION } from "./build-schema.ts";

/** Where the built page is checked in. Shared, so the writer and the drift test agree. */
export const SPEC_DOC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "SPEC.md",
);

type JsonSchema = Record<string, unknown>;

function isSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keywords this renderer consumes structurally — they become a type, a column or a section rather
 * than a rule. `title` and `description` are the document's own metadata at the root; a spec field
 * named `title` is a key under `properties`, not a keyword, so the two never collide.
 */
const STRUCTURAL_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "enum",
  "anyOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "propertyNames",
  "default",
]);

/**
 * Keywords that become the *Rules* column, in the order they are printed — fixed, so the page's
 * bytes do not depend on the order zod happened to emit its keys in.
 */
const RULE_KEYWORDS = [
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "exclusiveMinimum",
  "maximum",
  "exclusiveMaximum",
] as const;

const RULE_KEYWORD_SET: ReadonlySet<string> = new Set(RULE_KEYWORDS);

/** The keywords of one subschema that this renderer neither prints nor deliberately consumes. */
export function unrenderedKeywords(schema: JsonSchema): string[] {
  return Object.keys(schema).filter((k) => !STRUCTURAL_KEYWORDS.has(k) && !RULE_KEYWORD_SET.has(k));
}

/**
 * Every subschema in the document, paired with the path it sits at — the descent is by
 * schema-valued position only, exactly as test/schema.test.ts's own sweep is, and for the same
 * reason: `enum`, `required` and `default` hold DATA, and walking into an `enum` member would
 * report a spec author's string as a keyword.
 */
function allSubschemas(schema: JsonSchema, where: string): Array<readonly [string, JsonSchema]> {
  const found: Array<readonly [string, JsonSchema]> = [[where, schema]];
  const descend = (child: unknown, at: string): void => {
    if (isSchemaObject(child)) found.push(...allSubschemas(child, at));
  };

  const properties = schema["properties"];
  if (isSchemaObject(properties)) {
    for (const [key, sub] of Object.entries(properties)) descend(sub, `${where}.${key}`);
  }
  descend(schema["items"], `${where}[]`);
  descend(schema["additionalProperties"], `${where}.<value>`);
  descend(schema["propertyNames"], `${where}.<key>`);
  const branches = schema["anyOf"];
  if (Array.isArray(branches)) {
    for (const [i, branch] of branches.entries()) descend(branch, `${where} variant ${i + 1}`);
  }
  return found;
}

/**
 * Throw if the document carries a keyword this renderer would print nowhere.
 *
 * The failure it prevents is a page that is silently incomplete: a constraint added to
 * `ConnectorSpecSchema` in a keyword nothing here reads would leave the row it belongs to looking
 * finished. Model it, or add it to `STRUCTURAL_KEYWORDS` deliberately.
 */
export function assertEveryKeywordRendered(doc: JsonSchema): void {
  for (const [where, sub] of allSubschemas(doc, "(root)")) {
    const unrendered = unrenderedKeywords(sub)[0];
    if (unrendered !== undefined) {
      throw new Error(
        `build-spec-doc: nothing renders ${JSON.stringify(unrendered)} at ${where}. The spec ` +
          "language grew a construct this page does not print; render it, or add it to " +
          "STRUCTURAL_KEYWORDS deliberately, rather than shipping a reference that omits it.",
      );
    }
  }
}

/**
 * One field's type, as the *Type* column prints it.
 *
 * An object with `properties` renders INLINE here — `{ path: string[] }` — and that is not an
 * exception to the "objects get their own table" rule below. A table is named by the path a spec
 * author would write to reach it, and a branch of a union has no such path: there is no key that
 * selects it. So a union branch is rendered where it is used, and everything with a path is a
 * table.
 *
 * Throws rather than falling back for a shape it does not model, on the same reasoning
 * `assertEveryKeywordRendered` gives: a placeholder in this column reads as an answer.
 */
export function renderType(schema: JsonSchema): string {
  const branches = schema["anyOf"];
  if (Array.isArray(branches)) {
    return branches.map((b) => renderType(b as JsonSchema)).join(" | ");
  }

  const allowed = schema["enum"];
  if (Array.isArray(allowed)) return allowed.map((v) => JSON.stringify(v)).join(" | ");

  const type = schema["type"];
  if (type === "array") {
    const items = schema["items"];
    if (!isSchemaObject(items)) throw new Error("renderType: an array with no items subschema");
    const inner = renderType(items);
    return inner.includes(" | ") ? `(${inner})[]` : `${inner}[]`;
  }

  if (type === "object") {
    const properties = schema["properties"];
    if (isSchemaObject(properties)) return renderObjectLiteral(schema, properties);
    const values = schema["additionalProperties"];
    if (isSchemaObject(values)) return `Record<string, ${renderType(values)}>`;
    throw new Error("renderType: an object that is neither a record nor a shape");
  }

  if (typeof type !== "string") throw new Error("renderType: a subschema with no type");
  return type;
}

function renderObjectLiteral(schema: JsonSchema, properties: JsonSchema): string {
  const required = new Set((schema["required"] ?? []) as string[]);
  const fields = Object.entries(properties).map(
    ([key, sub]) => `${key}${required.has(key) ? "" : "?"}: ${renderType(sub as JsonSchema)}`,
  );
  return `{ ${fields.join("; ")} }`;
}

/** One constraint, as it prints: `minItems 1`, or `items minLength 1` under a nested one. */
function renderRule(keyword: string, value: unknown): string {
  if (keyword === "pattern") return `matches \`${String(value)}\``;
  if (keyword === "format") return `format \`${String(value)}\``;
  return `${keyword} ${JSON.stringify(value)}`;
}

/**
 * Every constraint a field carries, including the ones on its items, its record keys and values,
 * and each branch of a union — each labelled by where it applies.
 *
 * `stopAt` is the subschema that has a table of its own. Descent halts there, because that table
 * prints its fields' rules itself; without it, `tools[]`'s row on the root table would repeat
 * every rule in the whole tool schema.
 */
export function collectRules(
  schema: JsonSchema,
  stopAt: JsonSchema | undefined,
  label = "",
): string[] {
  const at = (text: string): string => (label === "" ? text : `${label} ${text}`);
  const out: string[] = [];

  for (const keyword of RULE_KEYWORDS) {
    if (keyword in schema) out.push(at(renderRule(keyword, schema[keyword])));
  }

  if (schema === stopAt) return out;

  const descend = (child: unknown, childLabel: string): void => {
    if (isSchemaObject(child)) out.push(...collectRules(child, stopAt, at(childLabel)));
  };

  const properties = schema["properties"];
  if (isSchemaObject(properties)) {
    for (const [key, sub] of Object.entries(properties)) descend(sub, `\`${key}\``);
  }
  descend(schema["items"], "items");
  descend(schema["propertyNames"], "keys");
  descend(schema["additionalProperties"], "values");
  const branches = schema["anyOf"];
  if (Array.isArray(branches)) {
    for (const [i, branch] of branches.entries()) descend(branch, `variant ${i + 1}`);
  }
  return out;
}

/**
 * A table: the path a spec author writes to reach it, and the object at that path.
 *
 * `isRoot` is carried rather than inferred from the path. The root's fields are written bare —
 * `name`, not `ConnectorSpec.name` — and every other section's are qualified, and a rule that
 * tried to tell them apart by inspecting the path got `filesystem` wrong: its path is one plain
 * word, exactly like the root's.
 */
type Section = { path: string; schema: JsonSchema; isRoot: boolean };

/**
 * The table a field leads to, if it leads to one — the object itself, the object inside an array,
 * or the object a record maps to.
 *
 * One function, so the walker that collects the tables and the renderer that links to them cannot
 * disagree about which fields have one.
 */
export function childSection(fieldPath: string, schema: JsonSchema): Section | undefined {
  if (isSchemaObject(schema["properties"])) return { path: fieldPath, schema, isRoot: false };

  const items = schema["items"];
  if (isSchemaObject(items) && isSchemaObject(items["properties"])) {
    return { path: `${fieldPath}[]`, schema: items, isRoot: false };
  }

  const values = schema["additionalProperties"];
  if (isSchemaObject(values) && isSchemaObject(values["properties"])) {
    return { path: `${fieldPath}.<name>`, schema: values, isRoot: false };
  }

  return undefined;
}

/** How a linked type prints: the wrapper the section sits inside, with `object` in the middle. */
function linkedType(fieldPath: string, section: Section): string {
  if (section.path === fieldPath) return "object";
  if (section.path === `${fieldPath}[]`) return "object[]";
  return "Record<string, object>";
}

/**
 * GitHub's heading anchor, for a heading whose text is a single code span: lowercase, drop
 * everything that is not a letter, a digit, a space or a hyphen, and hyphenate the spaces. Every
 * heading here is a field path, so this stays inside the simple part of that algorithm.
 */
export function anchor(headingText: string): string {
  return headingText
    .toLowerCase()
    .replaceAll(/[^a-z0-9 -]/g, "")
    .replaceAll(" ", "-");
}

/** `|` ends a cell, so a value carrying one has to be escaped before it lands in a table. */
function cell(text: string): string {
  return text.replaceAll("|", String.raw`\|`);
}

/**
 * The tables, in the order a reader meets them: the root, then every object reachable from it,
 * breadth-first, so a field's table follows the table that names the field.
 */
function collectSections(root: Section): Section[] {
  // A queue read from the head and appended to at the tail, kept separate from the result it
  // fills. The array being walked GROWS while it is walked — visiting a section discovers the
  // sections under it, and those have to be visited too — which is the whole reason this was a
  // cursor loop rather than a `for-of`. Naming the queue says that outright, where
  // `for (const s of sections) { … sections.push(child) }` relies on the reader knowing an Array
  // iterator re-reads `length` on every step: true, and it reads like a bug.
  const sections: Section[] = [];
  const pending: Section[] = [root];
  while (pending.length > 0) {
    const section = pending.shift()!;
    sections.push(section);
    const properties = section.schema["properties"];
    if (!isSchemaObject(properties)) continue;
    for (const [key, sub] of Object.entries(properties)) {
      const child = childSection(fieldPath(section, key), sub as JsonSchema);
      if (child !== undefined) pending.push(child);
    }
  }
  return sections;
}

/** The path a spec author writes to reach one field — and the key its gloss is stored under. */
function fieldPath(section: Section, key: string): string {
  return section.isRoot ? key : `${section.path}.${key}`;
}

/**
 * The one-line gloss per field: what it IS.
 *
 * **Not what makes it legal.** Every cross-field rule — which fields a `style` forbids, what an
 * `auth` mode requires, when a `default` may be written — lives in `ConnectorSpecSchema`'s
 * refinements and is deliberately absent here; `DOC_LIMITATION` says so on the page, and
 * hand-copying those rules into this table is the specific thing build-schema.ts's header argues
 * against. Two of them changed while the JSON Schema was being written.
 *
 * Every entry names a field the schema still has, and every field the schema has has an entry —
 * `glossGaps` fails the build otherwise, in both directions.
 */
const GLOSSES: Readonly<Record<string, string>> = {
  // ConnectorSpec
  name: "The connector's name, lower-kebab-case. It names the default output directory, the generated package (`nimbus-mcp-<name>`), and is what `title` and `id` default from.",
  title:
    "The service's name as it appears in emitted identifiers — `register<Title>Tool`, `create<Title>Syncable`, `<Title>SearchMatchOptions` — with non-alphanumerics stripped, and in the generated README's prose. `parseSpec` fills it with `name` capitalised, after the schema has run, which is why no default shows here.",
  displayName: "The manifest's `displayName`.",
  id: "The manifest's `id`. `parseSpec` fills it with `com.nimbus.<name>`, after the schema has run, which is why no default shows here.",
  description: "The manifest's `description`.",
  serviceLabel:
    "The service's name as two emitted positions read it: the error message for a non-2xx response, ``throw new Error(`<serviceLabel> ${status}: …`)``, and a block comment in the Gateway wiring.",
  style:
    "How the connector registers its tools, and the field with the widest blast radius in the language. [SPEC-RULES § Styles](./SPEC-RULES.md#styles-rest-kit-hand-rolled-read-only-kit).",
  handlerStyle:
    "How a REST tool's handler is written: `concise` is an expression-bodied arrow, `block` a statement body with an explicit `return`. A stub or search handler always has a block body.",
  argsSchemaStyle:
    "How a tool's `z.object({…})` argument schema is printed: on one line, or one field per line. `z.object({})` is always one line.",
  network: "The manifest's `permissions.network` — the hosts the connector may reach.",
  filesystem:
    "The manifest's `permissions.filesystem`. Omitted leaves the key out of the manifest entirely, which is a different statement from declaring it empty.",
  syncInterval:
    "The manifest's `syncInterval`, in seconds. The Gateway wiring multiplies it by 1000 for its `defaultIntervalMs`.",
  minNimbusVersion: "The manifest's `minNimbusVersion`.",
  env: "The environment variables the connector reads, grouped into the accessors the emitter declares.",
  fetchHelper:
    "The fetch helper the tools issue their requests through: its name, its base URL and its headers.",
  tools: "The tools the connector registers. `parseSpec` fills it with `[]` when it is absent.",

  // filesystem
  "filesystem.read": "The manifest's `permissions.filesystem.read`.",
  "filesystem.write": "The manifest's `permissions.filesystem.write`.",

  // env[]
  "env[].vars": "The environment variables this entry reads, in order.",
  "env[].local": "The accessor function the emitter declares for this entry.",
  "env[].bindings":
    "The const each var is read into inside the accessor body, one per `vars` entry. Defaults to the camelCase of the variable's name.",
  "env[].required":
    "Whether the accessor throws when a variable it reads is unset or empty. An `auth` mode emits the same guard.",
  "env[].default":
    "Substituted when the variable is unset or empty — the accessor reads `process.env[…]?.trim() || <default>` and needs no guard.",
  "env[].transform":
    'How a trailing slash is stripped from a user-supplied base URL: `stripTrailingSlash` inlines `.replace(/\\/$/, "")`, `trimTrailingSlashFn` emits the shared `trimTrailingSlash` helper once and calls it.',
  "env[].prefix":
    'Text placed before the accessor\'s value, spliced raw into the template literal — and, for `auth: "basic"`, before the username passed to `encodeBasicAuthHeader`.',
  "env[].suffix": "Text placed after the accessor's value, in the same two positions as `prefix`.",
  "env[].auth":
    "Which auth wrapper the accessor's value is built into. Omitted means the accessor returns the value itself.",
  "env[].headerNames": "The header name each variable's value is sent under.",
  "env[].tokenLocal":
    "Splits the accessor in two: a `(): string` of this name that reads and guards the raw token, leaving `local` a wrapper that builds the header from a call to it.",
  "env[].tokenUrl": "The token endpoint the client-credentials exchange POSTs to.",
  "env[].scope": "The `scope` sent with the client-credentials exchange.",
  "env[].credentialsIn":
    "Where the client id and secret go: an `Authorization: Basic` header, or the form body as `client_id`/`client_secret`.",

  // fetchHelper
  "fetchHelper.local":
    "The name of the fetch helper the emitter declares, and that a REST or search tool's handler calls.",
  "fetchHelper.base":
    "The base URL. A template over `${env.X}`, which `resolveEnvRefs` rewrites to a call to that accessor before emission.",
  "fetchHelper.baseConst":
    "Hoist `base` to a module-scope `const` of this name and reference it from the helper, instead of inlining the literal.",
  "fetchHelper.headers":
    "Names an env accessor returning the header record. Emitted as a call — `headers: <name>()`.",
  "fetchHelper.inlineHeaders":
    "A literal header object. A value that is exactly `${env.NAME}` is resolved to that accessor's call; every other value is JSON-quoted as written.",
  "fetchHelper.normalizeLeadingSlash":
    "Give the helper a `pathPart` local that prepends `/` to a path that does not start with one.",
  "fetchHelper.jsonFallbackRaw":
    "Return `{ raw: text }` for a response body that does not parse as JSON, instead of letting `JSON.parse` throw.",
  "fetchHelper.staticPathStyle":
    "How a fully-static path renders at a call site: quoted, or a backtick template literal.",

  // tools[]
  "tools[].name": "The tool's name, as MCP registers it.",
  "tools[].description": "The tool's description, as MCP registers it.",
  "tools[].args": "The tool's arguments, keyed by the name the generated schema declares.",
  "tools[].path":
    "The request path, a template over `${env.X}` and `${arg.X}` with an optional `|raw`, `|enc`, `|num` or `|bool` mode.",
  "tools[].query":
    "Query-string parameters built beside `path`, each emitted as a `searchParams.set` call — the only way to express a parameter that is sent conditionally. [SPEC-RULES § Conditional query parameters](./SPEC-RULES.md#conditional-query-parameters-query).",
  "tools[].pathWhen":
    "Guards evaluated in order before `path`, each selecting a different endpoint when its named argument is absent. `path` is the final unguarded return. [SPEC-RULES § Conditional endpoints](./SPEC-RULES.md#conditional-endpoints-pathwhen).",
  "tools[].impl":
    'What the tool does: a REST request, a handler that throws `"<tool> not implemented"`, or a substring search over one endpoint\'s rows. `get` is the Stage A spelling of `rest`, normalised at parse time.',
  "tools[].method": "The HTTP verb, and nothing more.",
  "tools[].effect":
    "The author's declaration of intent. The manifest's `hitlRequired` is the deduplicated set of non-`read` effects, and is deliberately not derived from `method`.",
  "tools[].body":
    "Argument name → the field name the request body sends it as. Omitted sends every argument the URL does not already carry.",
  "tools[].rows":
    "The property a search tool plucks from the response envelope. Omitted means the response is itself the array.",
  "tools[].maxLimit": "A search tool's per-connector result cap.",
  "tools[].filter":
    "The search filter emitted into `src/search-filter.ts`. [SPEC-RULES § Search tools](./SPEC-RULES.md#search-tools-impl-search-rows-maxlimit-and-filter).",

  // tools[].args.<name>
  "tools[].args.<name>.type": "The argument's type.",
  "tools[].args.<name>.optional": "Whether the caller may omit the argument.",
  "tools[].args.<name>.default":
    "The value the emitted hoist substitutes when the argument is absent.",
  "tools[].args.<name>.local": "The hoisted const's name. Defaults to the argument's own key.",
  "tools[].args.<name>.min": "Emitted as `.min(…)` on the argument's zod schema.",
  "tools[].args.<name>.max": "Emitted as `.max(…)` on the argument's zod schema.",
  "tools[].args.<name>.int": "Emitted as `.int()` on a number argument's zod schema.",

  // tools[].query[]
  "tools[].query[].name":
    "The query key as the API spells it — deliberately not an identifier check, since `page[size]` is a real corpus key.",
  "tools[].query[].arg": "The tool's argument supplying the value.",
  "tools[].query[].omitWhen":
    'Guards the emitted `searchParams.set`: `absent` tests `!== undefined`, `empty` adds `&& !== ""`. Omitted sends the parameter unconditionally.',

  // tools[].pathWhen[]
  "tools[].pathWhen[].absent": "The argument tested; this rung wins when it is `undefined`.",
  "tools[].pathWhen[].path":
    "The path to use when `absent` is undefined, in the same template DSL as `tools[].path`.",

  // tools[].filter
  "tools[].filter.export":
    "The `export const` this filter is emitted as in `src/search-filter.ts`.",
  "tools[].filter.fields":
    "The fields each row is matched on, in three entry kinds: a plain key, a nested `path` of two or more segments, or a `tags` entry. Omitted emits a throwing stub typed as `SearchFilter` for you to replace.",
  "tools[].filter.tags":
    "Also match tag names, by appending `tagText(row)` after the keyed fields.",
};

/** The two ways `GLOSSES` and the schema can disagree. Both fail the build. */
export function glossGaps(
  fieldPaths: readonly string[],
  glosses: Readonly<Record<string, string>> = GLOSSES,
): { missing: string[]; unknown: string[] } {
  const known = new Set(fieldPaths);
  return {
    missing: fieldPaths.filter((p) => !Object.hasOwn(glosses, p)),
    unknown: Object.keys(glosses).filter((p) => !known.has(p)),
  };
}

/**
 * Fail the build — and therefore the drift test — when the two disagree.
 *
 * `glosses` is a parameter so the failure itself can be reached from a test. A guard whose only
 * exercise is the passing case is the shape this repository keeps removing: it would go on
 * returning quietly if `glossGaps` were inverted.
 */
export function assertGlossesMatchSchema(
  fieldPaths: readonly string[],
  glosses: Readonly<Record<string, string>> = GLOSSES,
): void {
  const { missing, unknown } = glossGaps(fieldPaths, glosses);
  if (missing.length === 0 && unknown.length === 0) return;
  const unknownLine =
    unknown.length === 0
      ? ""
      : `  gloss for a field the schema has not got: ${unknown.join(", ")}\n`;
  throw new Error(
    "build-spec-doc: GLOSSES and ConnectorSpecSchema disagree.\n" +
      (missing.length === 0 ? "" : `  no gloss for: ${missing.join(", ")}\n`) +
      unknownLine +
      "  A field added to the schema must be documented in the same change; a field removed " +
      "from it must take its prose with it.",
  );
}

/**
 * The limitation, stated for a FIELD TABLE rather than for a JSON Schema document.
 *
 * `SCHEMA_LIMITATION` is quoted verbatim rather than paraphrased — it is the wording the published
 * schema's own `description` and README already carry, and a reader who meets the gap in two
 * places should meet the same sentence. What is added is the half specific to this page: a table
 * has a row per field, and "only valid when that other field is set to this" is not a property of
 * a field.
 */
const DOC_LIMITATION = [
  'A field-by-field reference cannot express *"only valid when that other field is set to this"* —',
  "the rule belongs to no single row. `ConnectorSpecSchema` carries a long list of such rules,",
  "written as `.refine`/`.superRefine` clauses, and `validateSpec` adds the reserved-identifier",
  "pass on top of them. None of them is on this page, for the same reason none of them is in the",
  "published JSON Schema this page is generated from:",
  "",
  `> ${SCHEMA_LIMITATION}`,
  "",
  "They are not hand-copied here on purpose. A prose copy of the acceptance rules is a second",
  "source of truth for the spec language, and it goes stale in days — two fields grew a new",
  "content rule while the JSON Schema was being written. Read them where they are enforced:",
  "",
  "- [`src/spec.ts`](../src/spec.ts) — every `.refine`/`.superRefine` on `ArgSchema`, `ToolSchema`,",
  "  `EnvSchema`, `FetchHelperSchema` and `ConnectorSpecSchema`, each carrying its own message and",
  "  the reasoning behind it.",
  "- [`src/validate.ts`](../src/validate.ts) — `RESERVED_IDENTIFIERS` and the identifier-collision",
  "  rules, which are a second pass, after `parseSpec` has returned.",
  "- [`test/schema.test.ts`](../test/schema.test.ts) — concrete specs that validate against the",
  "  schema and are then refused by the generator, pinning the gap rather than describing it.",
  "- [`docs/SPEC-RULES.md`](./SPEC-RULES.md) — the same rules in prose, grouped by the feature they",
  "  belong to.",
  "",
  "`bun src/cli.ts --spec <path> --dry-run` is what tells you a spec is actually accepted.",
].join("\n");

const INTRO = [
  "# The spec language, field by field",
  "",
  "Every field `ConnectorSpecSchema` accepts: its type, whether it is required, its default, and",
  "the constraints the schema itself enforces.",
  "",
  "**This page is generated.** `bun run build:spec-doc` rewrites it from",
  "[`schema/connector-spec.schema.json`](../schema/connector-spec.schema.json), which is itself",
  "generated from `ConnectorSpecSchema`, and `test/spec-doc.test.ts` byte-compares the checked-in",
  "file against a fresh build — so this page cannot drift from the language it describes, and it",
  "cannot describe a different language from the published schema. Edit",
  "`scripts/_lib/build-spec-doc.ts`, not this file.",
  "",
  "This is the index of what exists. How the fields work together — writes, search tools, the three",
  "styles, the OAuth exchange, the reserved identifiers — is [SPEC-RULES.md](./SPEC-RULES.md), and",
  "[USAGE.md](./USAGE.md) walks through writing a spec from scratch.",
  "",
  "## How to read a table",
  "",
  "- **Field** — the key as a spec file writes it. **(required)** means the schema demands it;",
  "  everything else may be omitted.",
  "- **Type** — the accepted shape. A list of literals is the set of accepted values, and `object`",
  "  links to that field's own table below.",
  "- **Default** — the default the schema document carries. Where a field is filled in by",
  "  `parseSpec` instead, or where the conversion to JSON Schema drops the default, this column",
  "  reads `—` and the last column says what the value is.",
  "- **Rules** — every constraint the schema carries for that field, including the ones on its",
  "  items, on a record's keys and values, and on each branch of a union.",
  "",
  "## What this page cannot tell you",
  "",
  DOC_LIMITATION,
].join("\n");

function renderRow(section: Section, key: string, schema: JsonSchema): string {
  const path = fieldPath(section, key);
  const required = ((section.schema["required"] ?? []) as string[]).includes(key);
  const child = childSection(path, schema);
  const type =
    child === undefined
      ? renderType(schema)
      : `[${linkedType(path, child)}](#${anchor(child.path)})`;
  const declared = schema["default"];
  const rules = collectRules(schema, child?.schema);

  const cells = [
    `\`${key}\`${required ? " **(required)**" : ""}`,
    child === undefined ? `\`${cell(type)}\`` : cell(type),
    declared === undefined ? "—" : `\`${cell(JSON.stringify(declared))}\``,
    rules.length === 0 ? "—" : cell(rules.join(", ")),
    // Non-null because `assertGlossesMatchSchema` has already run over every path this reaches;
    // a `?? ""` here would be an unreachable branch that also defeats that assertion's purpose.
    cell(GLOSSES[path]!),
  ];
  return `| ${cells.join(" | ")} |`;
}

function renderSection(section: Section): string {
  const properties = section.schema["properties"] as JsonSchema;
  const rows = Object.entries(properties).map(([key, sub]) =>
    renderRow(section, key, sub as JsonSchema),
  );
  return [
    `## \`${section.path}\``,
    "",
    "| Field | Type | Default | Rules | What it is |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/**
 * The page, as the exact bytes that belong on disk — trailing newline included, so the checked-in
 * file is an ordinary text file and the comparison in test/spec-doc.test.ts is a plain string
 * equality rather than a normalising one.
 */
export function buildSpecDoc(): string {
  const doc = JSON.parse(buildSchema()) as JsonSchema;
  assertEveryKeywordRendered(doc);

  const sections = collectSections({ path: String(doc["title"]), schema: doc, isRoot: true });
  assertGlossesMatchSchema(
    sections.flatMap((section) =>
      Object.keys(section.schema["properties"] as JsonSchema).map((key) => fieldPath(section, key)),
    ),
  );

  return `${[INTRO, ...sections.map(renderSection)].join("\n\n")}\n`;
}
