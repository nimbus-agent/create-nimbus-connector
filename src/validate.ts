import type { ConnectorSpec, EnvSpec, PathSegment } from "./spec.ts";
import {
  envRefNames,
  needsExtractor,
  parsePathTemplate,
  registrarName,
  titleIdentifier,
} from "./spec.ts";

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
  //
  // The four at the end of this block were MISSING while their siblings were listed, and the
  // gap is what the standing rule in CLAUDE.md exists to prevent. They were found by scanning
  // every emitted `.ts` file — all 24 fixtures, both targets, plus the Gateway wiring and the
  // branch shapes no fixture reaches — for FREE identifiers: names a module references without
  // declaring or importing them. That scan ships as test/emitted-globals.test.ts, so the next
  // emitter to reach for a global fails there instead of arriving as a missing entry here.
  //
  //   Date Math Number   renderTokenFunction (env.ts) writes `Date.now()`, `Math.min`,
  //                      `Math.floor` and `Number.POSITIVE_INFINITY`. A `local` of any of the
  //                      three shadows the global with the accessor function and every one of
  //                      those property reads becomes TS2339 — compiled, not reasoned about.
  //   undefined          broader than the other three, and not a client-credentials matter at
  //                      all: `guardLines` writes `<binding> === undefined` in EVERY branch that
  //                      guards. A module-scope declaration of that name makes the comparison
  //                      TS2367 ("no overlap") in both the plain and the client-credentials
  //                      shapes. `accessorReferences` below already refuses it as a BINDING;
  //                      nothing refused it as a `local`.
  //
  // `Record` is free in the emitted output too and is deliberately NOT here: it is a type-space
  // name, `function Record(): Record<string, string>` declares a value and resolves the
  // annotation in the other namespace, and it compiles clean under --strict. Measured, the same
  // way `<X>SearchMatchOptions` was — a name that only looks like a collision is not one, and
  // reserving it would reject a spec that works.
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
  "Date",
  "Math",
  "Number",
  "undefined",
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
 * Whether the entry's accessor emits a `throw new Error(…)`, and so references BOTH `Error` and
 * `undefined` — the guard's own `=== undefined` test sits on the same line as the throw it gates.
 *
 * `renderBasic` and `renderTokenFunction` (src/emit/server/env.ts) always throw: the first guards
 * every var unconditionally, the second on a non-2xx token response and on a response carrying no
 * `access_token`, neither of which `default` suppresses. Every other branch throws exactly when
 * `guardLines` emits, and the second line below is that function's condition.
 */
function emitsThrow(e: EnvSpec): boolean {
  if (e.auth === "basic" || e.auth === "client-credentials") return true;
  return e.default === undefined && (e.required || e.auth !== undefined);
}

/**
 * The names an env entry's OWN accessor body references — which is exactly the set a `binding`
 * declared in that body can shadow.
 *
 * `readLines` (src/emit/server/env.ts) emits `const <binding> = …` INSIDE an accessor whose body
 * also names module-scope declarations and globals, and nothing checked the two against each
 * other. The same complaint `checkRowsIdentifier` below answers, one field over.
 *
 * **Entry-scoped, and that is the whole design.** The obvious fix — checking `bindings` against
 * the `seen` map the way `rows` is checked — was measured and rejected: it refuses `grafana`,
 * `sentry`, `zzscratch` and `zzstandalonehand` (`bindings: ["u"]`, and `u` is reserved for the
 * conditional-query branch's URL const) and `zendesk` (`bindings: ["email", "token"]` on a
 * **basic** entry, where nothing named `token` is emitted at all). Two of those five are
 * byte-locked. A binding is function-scoped to one accessor, so the only names it can collide
 * with are the ones THAT accessor's own body mentions; every other module-scope name is merely
 * shadowed, harmlessly, in a body that never reads it.
 *
 * Derived from the emitter branch by branch, then measured: every name below was compiled as a
 * binding in every entry shape that reaches it, under `tsc --strict`. The failures, by branch —
 *
 *   process              TS7022 + TS2448, every branch (`const process = process.env[…]`)
 *   Error                TS2351 `new Error(…)` on a string
 *   undefined            compiles CLEAN and breaks at runtime: the guard becomes
 *                        `if (undefined === undefined || …)`, comparing the const with itself, so
 *                        the accessor throws "X is not set" even when X is set — confirmed by
 *                        running the emitted accessor, not by reading it
 *   trimTrailingSlash    TS2349, `return trimTrailingSlash(trimTrailingSlash)`
 *   encodeBasicAuthHeader TS2349
 *   cachedToken          TS2448 + TS2588 (read on the line above, then assigned)
 *   tokenExpiresAt       TS2448 + TS2588
 *   body res text parsed ttl   TS2451, a second `const` of a name the same block declares
 *   Date URLSearchParams fetch String JSON Math Number   TS2339/TS2349/TS2351 on a shadowed global
 *
 * `token` is deliberately ABSENT, against the finding that prompted this check. It is the name
 * `renderTokenFunction` gives the enclosing function, and that function's body never calls it —
 * only the wrapper accessor below it does, from a different scope. `bindings: ["token"]` on a
 * client-credentials entry compiles clean, so refusing it would need a reason that is not true.
 * The reproduction that named it, `["token", "cachedToken"]`, fails on the second name.
 */
export function accessorReferences(e: EnvSpec): string[] {
  // readLines emits `process.env[…]` in every branch there is.
  const names = ["process"];
  if (emitsThrow(e)) names.push("Error", "undefined");
  // `transformed()` is reached only from the plain return path, and EnvSchema already refuses
  // `transform` beside any `auth` — so this field alone implies the branch that calls it.
  if (e.transform === "trimTrailingSlashFn") names.push("trimTrailingSlash");
  if (e.auth === "basic" || (e.auth === "client-credentials" && e.credentialsIn === "basic")) {
    names.push("encodeBasicAuthHeader");
  }
  if (e.auth === "client-credentials") {
    // renderTokenFunction's body, in emission order: the cache check, the form body, the
    // request, the response, the parse, the ttl computation.
    names.push(
      "cachedToken",
      "tokenExpiresAt",
      "Date",
      "URLSearchParams",
      "body",
      "fetch",
      "res",
      "text",
      "String",
      "JSON",
      "parsed",
      "Math",
      "ttl",
      "Number",
    );
  }
  return names;
}

/** A binding may shadow anything except what the accessor it is declared in already reads. */
function checkEnvBindings(spec: ConnectorSpec): void {
  for (const e of spec.env) {
    if (e.bindings === undefined) continue;
    const referenced = new Set(accessorReferences(e));
    for (const b of e.bindings) {
      if (!referenced.has(b)) continue;
      throw new Error(
        `Identifier collision: env accessor "${e.local}" declares "const ${b}" for ` +
          `${e.vars.join(", ")}, and its own body already references "${b}" — the declaration ` +
          `shadows it for the rest of the accessor. Rename the "bindings" entry. (This is scoped ` +
          `to THIS entry's shape: another entry, or this one with different "auth"/"transform", ` +
          `may use "${b}" freely, because each accessor is its own function scope.)`,
      );
    }
  }
}

/**
 * Four emitted names are built from `titleIdentifier(spec.title)` — `register<X>Tool`
 * (`registrarName`), `create<X>Syncable` and `map<X>ItemToItem` (src/emit/wiring.ts), and
 * `<X>SearchMatchOptions` (src/emit/search-filter.ts) — and exactly ONE of them puts the stripped
 * title at the START of an identifier. That one position is where the requirement comes from.
 *
 * **The reason stated here before was false for three of the four.** A digit is illegal only as an
 * identifier's FIRST character, so `register1PasswordTool`, `create1PasswordSyncable` and
 * `map1PasswordItemToItem` all compile — checked under `tsc --strict`, not reasoned about.
 * `export type 1PasswordSearchMatchOptions` is the one that does not: TS2457, *Type alias name
 * cannot be '1'*, with three parse errors around it. The empty string breaks the same position and
 * only that one, differently — `export type SearchMatchOptions = SearchMatchOptions` is a circular
 * alias, TS2456, while `registerTool`, `createSyncable` and `mapItemToItem` are ordinary names.
 *
 * The rule stays FLAT: `title` needs a leading letter whether or not the spec declares a search
 * tool. That is the argument `RESERVED_IDENTIFIERS` above makes explicitly for itself — a value
 * that validates or fails depending on a field elsewhere in the file is worse than a rule that is
 * slightly wide — and it carries further here, because the alternative is a `title` that becomes
 * invalid the moment a search tool is added to a connector that already shipped.
 *
 * Checked here rather than on `title` in the schema because the field is OPTIONAL: `parseSpec`
 * fills it from `capitalize(spec.name)`, so a schema-level refine would leave the defaulted
 * value unchecked, which is the half a user never writes and therefore never suspects.
 *
 * Stripping rescues "Google Meet" and "Google-meet". No corpus connector directory name begins
 * with a digit, so this rejects nothing `--from-connector` can produce.
 */
function validateTitleIdentifier(spec: ConnectorSpec): void {
  const id = titleIdentifier(spec.title);
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(id)) return;
  throw new Error(
    `"title" ${JSON.stringify(spec.title)} yields ${JSON.stringify(id)} once non-alphanumeric ` +
      'characters are stripped, and the generator emits "<X>SearchMatchOptions" as a type-alias ' +
      "NAME — which puts that value at the start of an identifier, where it must begin with a " +
      'letter and cannot be empty. The other three names built from it ("register<X>Tool", ' +
      '"create<X>Syncable", "map<X>ItemToItem") embed it, and a leading digit is legal there; ' +
      "the rule is applied to every spec so that adding a search tool cannot change whether " +
      '"title" is valid. Give "title" a value starting with a letter.',
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
  // After the claims, before anything else: a binding collides with names inside ONE accessor,
  // which the shared `seen` map cannot express — see accessorReferences.
  checkEnvBindings(spec);

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
  validateFetchHelperEnvRefs(spec);
}

/**
 * A `${env.X}` in the fetch helper must name an env accessor the spec declares.
 *
 * The gap this closes: `resolveEnvRefs` (src/emit/server/fetch-helper.ts) rewrites `${env.X}` to
 * `${X()}` unconditionally — it resolves the SHAPE and never asks whether the name exists. A base
 * of `https://${env.nosuch}` therefore emits a call to an undeclared function, so the generated
 * package fails its own `tsc` with TS2304 and the spec author learns about it from a compiler
 * error in emitted code rather than from the validator. `validateEnvSegment` has asked exactly
 * this question of tool *paths* since Stage A; the fetch helper was simply never asked.
 *
 * **Here rather than in `FetchHelperSchema`, because the question spans two fields.** A zod
 * refinement on `fetchHelper` cannot see `spec.env`, which is why this is the validator's job and
 * not the schema's — the same division `validateEnvSegment` and the identifier-collision rules
 * already sit on.
 *
 * **Only the reference's TARGET is checked here.** Whether a value may mix text with a reference
 * at all is `FetchHelperSchema`'s `superRefine` (see `isEnvRefHeaderValue`), which rejects
 * `"Token ${env.org}"` at parse time — earlier than this, with a better message, and using the
 * emitter's own predicate. Restating that check here would produce two rejections for one mistake
 * and put a third copy of the pattern in the tree; `envRefNames` is imported for the same reason.
 *
 * rest-kit is exempt because it cannot reach here with a reference at all: `ConnectorSpecSchema`
 * already refuses `${env.` anywhere in a rest-kit `fetchHelper`, the registrar resolving the
 * single credential itself. The guard is a cheap statement of that, not a second rule.
 */
function validateFetchHelperEnvRefs(spec: ConnectorSpec): void {
  if (spec.style === "rest-kit") return;

  const declared = new Set(spec.env.map((e) => e.local));
  // The tail that names what the author could have meant, since the fix is almost always one of
  // the locals already in the spec. Built once, outside the loop and outside the message, rather
  // than as a conditional nested inside the template — the two spellings read the same and only
  // one of them survives being edited.
  const known = spec.env.map((e) => `"${e.local}"`).join(", ");
  const declaredNote =
    known === "" ? " (the spec declares no env entries)" : ` — declared: ${known}`;

  const check = (where: string, template: string): void => {
    for (const name of envRefNames(template)) {
      if (declared.has(name)) continue;
      throw new Error(
        `${where} references "\${env.${name}}", but no env entry declares local "${name}"` +
          `${declaredNote}. ` +
          "The emitter rewrites it to a call, so the generated connector would not compile.",
      );
    }
  };

  check("The fetch helper's base", spec.fetchHelper.base);
  for (const [header, value] of Object.entries(spec.fetchHelper.inlineHeaders ?? {})) {
    check(`Inline header ${JSON.stringify(header)}`, value);
  }
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
    // A guard path is the same DSL in a second position and src/emit/server/tools-hand.ts
    // renders it through the same code, so it must face the same checks. Unchecked, an
    // undeclared ${arg.X}/${env.X} reaches the author as TS2339/TS2304 against generated
    // source; worse, a |bool on a non-boolean arg falls back to a raw reference, which
    // compiles — the wrong URL is requested and nothing reports it. That silent case is the
    // whole reason validateArgSegment exists.
    for (const g of t.pathWhen ?? []) {
      validateToolPath(spec, t, g.path);
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
 * name the extractor or auto-suffixing it: one corpus connector does not justify spec surface,
 * and an auto-suffix would invent a name no corpus file contains — so the second extractor
 * could never byte-match anyway, which is the whole point of the field.
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
