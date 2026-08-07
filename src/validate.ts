import type { ConnectorSpec, PathSegment } from "./spec.ts";
import { needsExtractor, parsePathTemplate, registrarName, titleIdentifier } from "./spec.ts";

/** Identifiers the emitter itself introduces. A spec may never reuse one. */
export const RESERVED_IDENTIFIERS: readonly string[] = [
  "mcp",
  "server",
  "reg",
  "transport",
  "z",
  "jsonResult",
  "p",
  "parsed",
  "path",
  "pathPart",
  "res",
  "text",
  "McpServer",
  "StdioServerTransport",
  "createRegisterSimpleTool",
  "createZodToolRegistrar",
  "makeRestToolRegistrar",
  "requireProcessEnv",
  // Stage C's client-credentials branch emits these at module scope (see env.ts's
  // renderTokenFunction) and imports encodeBasicAuthHeader for credentialsIn: "basic".
  // Verified collision: a single entry whose env `local` is "token" or "cachedToken" emits
  // two declarations of that name in the same module.
  "token",
  "cachedToken",
  "tokenExpiresAt",
  "encodeBasicAuthHeader",
  // Stage D's transform: "trimTrailingSlashFn" emits `function trimTrailingSlash` at module
  // scope (see env.ts), so a `local` of that name would be declared twice.
  "trimTrailingSlash",
  "URLSearchParams",
  // The read-only-kit style and search tools, all of them names the emitted src/server.ts
  // declares or binds at module scope. Reserved unconditionally, matching how "token" and
  // "cachedToken" are treated: the list is a flat set checked before any style or tool kind is
  // considered, and making entries conditional would mean a spec validating or failing
  // depending on a field elsewhere in the file.
  //
  //   runReadOnlyMcpConnector  imported (monorepo) or declared by the emitted glue (standalone)
  //   ZodToolRegistrar         the glue's registrar type alias, standalone only
  //   searchToolInputSchema    imported (monorepo) or declared by the emitted glue (standalone)
  //   matchesResult            imported by every search connector
  //   McpListResult
  //   ZodObjectSchema          type imports the two standalone glues' signatures name
  //   SearchMatchOptions
  //
  // "root" is the one that is not an import: renderSearchTool emits `const root = await
  // <fetchHelper.local>(...)` for a search tool with `rows`. A fetch helper named "root" emits
  // `const root = await root(...)`, which is a use-before-declaration error rather than a
  // shadow. Function-scope rather than module-scope, but the failure mode and the fix are the
  // same, and reserving it keeps the rule one rule.
  "runReadOnlyMcpConnector",
  "ZodToolRegistrar",
  "searchToolInputSchema",
  "matchesResult",
  "McpListResult",
  "ZodObjectSchema",
  "SearchMatchOptions",
  "root",
  // Globals the emitted code calls directly — a `local` that shadows one produces valid
  // syntax that fails only at `tsc` (or worse, at runtime), e.g. `local: "fetch"` emits
  // `function fetch()` shadowing the global, then calls it with two arguments. "URL" belongs
  // here rather than beside "root" above: the conditional-query branch's `const u = new
  // URL(<path>)` calls the global directly, the same shadow risk as "fetch" or "JSON", not
  // the use-before-declaration risk "root" is reserved for.
  "fetch",
  "process",
  "JSON",
  "String",
  "Error",
  "encodeURIComponent",
  "Promise",
  "console",
  "RequestInit",
  "URL",
  // Stage E's extractor branch. src/server.ts imports the filter export from
  // ./search-filter.ts, so that name lands in server.ts's module scope beside the fetch
  // helper; the rest are declared or imported by src/search-filter.ts itself.
  //
  //   fieldsOf                 the extractor the fieldsOf branch declares
  //   asObjectish              its guard
  //   stringField              plain-key entries
  //   nestedString              path entries
  //   tagText/tagNamesFromObjects   tag entries
  //   makeQueryFilter/fieldsFromKeys  emitted since Stage D, never reserved until now
  //
  // Reserved flat and unconditionally, matching the rule the list already states: making an
  // entry conditional would mean a spec validating or failing depending on a field elsewhere
  // in the file. This slightly over-rejects — an env accessor named "stringField" collides
  // with nothing real — and that cost is accepted for one rule instead of two.
  "fieldsOf",
  "asObjectish",
  "stringField",
  "nestedString",
  "tagText",
  "tagNamesFromObjects",
  "makeQueryFilter",
  "fieldsFromKeys",
  // The conditional-query branch's hand-rolled handler emits `const u = new URL(<path>)` and
  // then, in the same scope, calls `await <fetchHelper.local>(path)`. Unlike "root" above,
  // there is no self-reference in the initializer — `new URL(...)` never mentions the fetch
  // helper, so the const finishes constructing cleanly. The failure lands one statement
  // later: a fetch helper named "u" shadows that const, so the handler's own call resolves
  // to the URL value instead of the function — a wrong-target call ("u is not callable" at
  // tsc), not a use-before-declaration. In the rest-kit branch this never fires — the path
  // callback never references the fetch helper, which lives in the module-scope factory
  // instead — but the reservation stays unconditional, matching the rule this list already
  // states: RESERVED_IDENTIFIERS is a flat set checked before any style is considered, and
  // making an entry conditional would mean a spec validating or failing depending on a field
  // elsewhere in the file. Corpus note: the URL local's name is genuinely split (search x23,
  // u x20, params x15, qs x10), and "u" is chosen not for being the corpus majority but
  // because it is what discord and google-meet write — the two connectors this branch exists
  // to reproduce.
  "u",
  // Task 4 fix round 2: the query branch's absolute-URL passthrough (fetch-helper.ts's
  // hasQueryTool gate) declares `const url = path.startsWith("http") ? path : ...` at
  // function scope, inside `renderFetchHelper` (the read helper) and `renderWriteHelper` —
  // and it was already there, unconditionally, in `renderRestKitFetchHelper` before this
  // feature existed. Two collisions, same shape as "u"'s reservation above: a fetch helper
  // named "url" shadows the passthrough const, so the emitted `fetch(url, ...)` calls a
  // string with .startsWith() semantics gone (a compile error only if url() is then called
  // as a function, e.g. via `headers: url()`); a `baseConst: "url"` shadows it the other way
  // — the passthrough's own initializer references `${base}` where `base` resolves to
  // `${url}`, so `const url = ... : \`${url}${path}\`` reads `url` before its own
  // declaration finishes (TS2448). Reserved unconditionally, not only when a query tool
  // exists: RESERVED_IDENTIFIERS is checked before any tool kind is considered, and rest-kit
  // has emitted this same `const url` unconditionally since before "u"/"URL" were reserved —
  // this entry was simply missed then.
  "url",
];

function claim(seen: Map<string, string>, name: string, owner: string): void {
  const prior = seen.get(name);
  if (prior !== undefined) {
    throw new Error(
      `Identifier collision: "${name}" is used by both ${prior} and ${owner}. ` +
        `Rename one via its "local" field.`,
    );
  }
  seen.set(name, owner);
}

/** Every env accessor is a module-scope function, so every one of their names is claimed. */
function claimEnvIdentifiers(seen: Map<string, string>, spec: ConnectorSpec): void {
  for (const e of spec.env) {
    claim(seen, e.local, `env accessor for ${e.vars.join(", ")}`);
    // The split-bearer form declares a second function beside `local`; both are module
    // scope, so both have to be claimed or the collision surfaces only at tsc.
    if (e.tokenLocal !== undefined) {
      claim(seen, e.tokenLocal, `the raw-token accessor for ${e.vars.join(", ")}`);
    }
  }
}

/**
 * Four emitted names are built by wrapping `titleIdentifier(spec.title)` — `register<X>Tool`,
 * `create<X>Syncable`, `map<X>ItemToItem` and `<X>SearchMatchOptions` — so the stripped title
 * has to be usable as the middle of an identifier.
 *
 * Checked here rather than on `title` in the schema because the field is OPTIONAL: `parseSpec`
 * fills it from `capitalize(spec.name)`, so a schema-level refine would leave the defaulted
 * value unchecked, which is the half a user never writes and therefore never suspects.
 *
 * Stripping rescues "Google Meet" and "Google-meet". It cannot rescue a title whose first
 * character is a digit ("1Password" yields `register1PasswordTool`) or one with no alphanumeric
 * character at all (which yields the empty string, and `export type SearchMatchOptions =
 * SearchMatchOptions` — a circular alias, TS2456). No corpus connector directory name begins
 * with a digit, so this rejects nothing `--from-connector` can produce.
 */
function validateTitleIdentifier(spec: ConnectorSpec): void {
  const id = titleIdentifier(spec.title);
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(id)) return;
  throw new Error(
    `"title" ${JSON.stringify(spec.title)} yields ${JSON.stringify(id)} once non-alphanumeric ` +
      "characters are stripped, which cannot be part of an emitted identifier — the generator " +
      'builds "register<X>Tool", "create<X>Syncable", "map<X>ItemToItem" and ' +
      '"<X>SearchMatchOptions" from it. Give "title" a value starting with a letter and ' +
      "containing at least one letter or digit.",
  );
}

export function validateSpec(spec: ConnectorSpec): void {
  const seen = new Map<string, string>();

  for (const r of RESERVED_IDENTIFIERS) {
    seen.set(r, "a reserved emitter identifier");
  }

  validateTitleIdentifier(spec);

  if (spec.style === "rest-kit") {
    claim(seen, registrarName(spec), "the rest-kit tool registrar");
  }

  claimEnvIdentifiers(seen, spec);

  // Module-scope `const <baseConst> = "<base>";`, claimed for the same reason.
  if (spec.fetchHelper.baseConst !== undefined) {
    claim(seen, spec.fetchHelper.baseConst, "the fetch helper's base const");
  }
  claim(seen, spec.fetchHelper.local, "the fetch helper");
  // Claimed unconditionally, not only when a non-GET tool exists: the name is derived from
  // fetchHelper.local, so whether it collides is a property of the spec's identifiers, and a
  // spec that validates today must not start failing the moment a write tool is added to it.
  claim(seen, `${spec.fetchHelper.local}Send`, "the write helper");

  validateTools(seen, spec);
  validateSingleExtractor(spec);
}

type ToolLike = ConnectorSpec["tools"][number];
type ArgSegment = Extract<PathSegment, { kind: "arg" }>;
type EnvSegment = Extract<PathSegment, { kind: "env" }>;

/** Only a hoisted argument declares a name of its own, so only a hoisted one is claimed. */
function claimHoistedArgs(seen: Map<string, string>, t: ToolLike): void {
  for (const [argName, arg] of Object.entries(t.args)) {
    const local = arg.local ?? argName;
    const hoisted = arg.default !== undefined || arg.type === "boolean";
    if (hoisted) {
      claim(seen, local, `the hoisted argument "${argName}" of tool ${t.name}`);
    }
  }
}

/**
 * `rows` names a const `renderSearchTool` declares inside ONE search handler, so it is checked
 * against every name already claimed and then deliberately NOT claimed itself.
 *
 * Not claimed, because two search tools may legitimately use the same `rows` — `zzextract`'s two
 * tools both say `"rows": "items"`, and each declaration is function-scoped to its own handler.
 * Claiming would reject that fixture.
 *
 * Checked, because everything in the enclosing module scope IS reachable from inside the handler
 * and a `const` there shadows it for the whole block. Three failures, each reproduced before this
 * check existed: `"root"` emits `const root = await zzGet(…)` immediately followed by
 * `const root = (root as …)` — a duplicate `const` in one block, which Biome formats happily;
 * `"p"` redeclares the handler parameter and then passes the rows array where the search params
 * belong; and the fetch helper's own name shadows the function the line above it just called.
 * `RESERVED_IDENTIFIERS` already lists `root` and `p` — with a comment on `root` citing this very
 * emitter — and `rows` was the one field that could collide with them and never reached the list.
 */
function checkRowsIdentifier(seen: Map<string, string>, t: ToolLike): void {
  if (t.rows === undefined) return;
  const prior = seen.get(t.rows);
  if (prior === undefined) return;
  throw new Error(
    `Identifier collision: tool ${t.name}'s "rows": "${t.rows}" names a const the search ` +
      `handler declares, and "${t.rows}" is already ${prior} — the declaration would shadow ` +
      `it inside the handler. Rename it, or plumb the response through a differently named key.`,
  );
}

/** Tool names are unique, and every name a tool contributes to module scope is claimed. */
function validateTools(seen: Map<string, string>, spec: ConnectorSpec): void {
  const toolNames = new Set<string>();
  for (const t of spec.tools) {
    if (toolNames.has(t.name)) {
      throw new Error(`Duplicate tool name: "${t.name}".`);
    }
    toolNames.add(t.name);

    // server.ts does `import { <export> } from "./search-filter.ts"`, so the filter export
    // occupies server.ts's module scope too — not only search-filter.ts's.
    if (t.filter !== undefined) {
      claim(seen, t.filter.export, `the search filter for tool ${t.name}`);
    }

    claimHoistedArgs(seen, t);
    // After this tool's own filter export and hoisted args are claimed, so a collision with
    // either of them is visible; before the next tool's, which are in a different scope.
    checkRowsIdentifier(seen, t);

    if (t.path !== undefined) {
      validateToolPath(spec, t, t.path);
    }
  }
}

/**
 * A connector may declare at most one search filter that takes the extractor branch:
 * extractorFilter (src/emit/search-filter.ts) hardcodes the name "fieldsOf", and
 * emitSearchFilter maps it over every tool taking that branch, so a second one emits a
 * second `function fieldsOf(...)` in the same module — TS2393 Duplicate function
 * implementation, and because both hoist, the second silently wins for both makeQueryFilter
 * calls. Corpus measurement: the only corpus connector with two extractors in one file is
 * readwise (`fieldsOf` and `bookFieldsOf`) — its field lists are otherwise expressible, so
 * this rule alone is what keeps it unreachable. Rejected rather than adding a spec field to
 * name the extractor or auto-suffixing it, per the Stage E design's declined-options list.
 */
function validateSingleExtractor(spec: ConnectorSpec): void {
  const extractorTools = spec.tools.filter(
    (t) => t.filter !== undefined && needsExtractor(t.filter),
  );
  if (extractorTools.length > 1) {
    const names = extractorTools.map((t) => `"${t.name}"`).join(", ");
    throw new Error(
      `A connector may declare at most one search filter that needs a bespoke fieldsOf ` +
        `extractor, but ${names} all do — src/search-filter.ts would declare ` +
        '"function fieldsOf" more than once, and the second declaration silently wins for ' +
        "every makeQueryFilter call in the file. Reduce one tool's filter to plain string " +
        "fields (the fieldsFromKeys branch), or split it into its own connector.",
    );
  }
}

/** A `${arg.X}` reference must name an arg the tool declares, with a mode that fits its type. */
function validateArgSegment(t: ToolLike, seg: ArgSegment): void {
  const arg = t.args[seg.name];
  if (arg === undefined) {
    throw new Error(
      `Tool "${t.name}" path references "\${arg.${seg.name}}", but declares no arg named ` +
        `"${seg.name}".`,
    );
  }
  // |bool renders the hoisted boolean local (the "true"/"false" conversion comes from
  // the hoist itself, keyed on type === "boolean" — see renderHoists). Applied to any
  // other type it would silently fall back to a raw, non-hoisted reference.
  if (seg.mode === "bool" && arg.type !== "boolean") {
    throw new Error(
      `Tool "${t.name}" path references "\${arg.${seg.name}|bool}", but "${seg.name}" is ` +
        `declared as type "${arg.type}", not "boolean" — |bool only makes sense on a ` +
        "boolean argument.",
    );
  }
}

/** A `${env.X}` reference must name a declared env accessor, and rest-kit emits none. */
function validateEnvSegment(spec: ConnectorSpec, t: ToolLike, seg: EnvSegment): void {
  if (spec.style === "rest-kit") {
    throw new Error(
      `Tool "${t.name}" path references "\${env.${seg.name}}", but a rest-kit connector ` +
        "cannot reference ${env.X} in a tool path — rest-kit emits no env accessors, so " +
        "the call would be undefined.",
    );
  }
  if (!spec.env.some((e) => e.local === seg.name)) {
    throw new Error(
      `Tool "${t.name}" path references "\${env.${seg.name}}", but no env entry has ` +
        `local "${seg.name}".`,
    );
  }
}

/**
 * Resolve every `${arg.X}` / `${env.X}` placeholder in a tool's path against the spec
 * that declared it. `parsePathTemplate` only knows placeholder syntax; it has no notion
 * of which args a tool declares or which env locals a spec declares, so an undeclared
 * reference parses cleanly and fails only later, at `tsc`, with no clue which spec field
 * was responsible.
 */
function validateToolPath(spec: ConnectorSpec, t: ToolLike, path: string): void {
  for (const seg of parsePathTemplate(path)) {
    if (seg.kind === "arg") validateArgSegment(t, seg);
    if (seg.kind === "env") validateEnvSegment(spec, t, seg);
  }
}
