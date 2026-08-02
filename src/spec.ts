import { z } from "zod";

/**
 * Tool keys rejected with a targeted message rather than Zod's generic "unrecognized key".
 * Detected before Zod so the error explains the boundary and names the alternative.
 *
 * The message used to read "is not supported in Stage A (… a later Stage C task)". Stage C
 * happened, and it did not add `hitl` — the manifest's `hitlRequired` array is computed from
 * each tool's `effect` instead, deliberately (see the Stage C design doc §1.1: `hitlRequired`
 * is a manifest-level capability array in all 94 corpus connectors, never per-tool). The
 * message now says what is true and what to write instead, and does not promise a stage.
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
const identifierField = () => z.string().regex(IDENTIFIER_RE, "must be a valid JS identifier");

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

export const ToolSchema = z
  .strictObject({
    name: z.string().min(1),
    description: z.string().min(1),
    args: z
      .record(
        z
          .string()
          .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "argument name must be a valid JS identifier"),
        ArgSchema,
      )
      .default({}),
    path: z.string().optional(),
    query: z
      .array(QueryParamSchema)
      .min(1, "a query must declare at least one parameter")
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
    /** Property plucked from the response envelope. Omitted means the response IS the array. */
    rows: z.string().min(1).optional(),
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
  .refine((t) => !(t.query !== undefined && (t.path ?? "").includes("?")), {
    message:
      '"query" and a "?" inside "path" both write the query string — use one. A tool that ' +
      'needs "query" moves its whole query string there.',
  })
  .superRefine((t, ctx) => {
    if (t.query === undefined) return;
    const seen = new Set<string>();
    for (const [i, q] of t.query.entries()) {
      // `q.arg in t.args` reaches inherited properties (`"toString"` would pass with an empty
      // `args: {}`), and the renderer would then emit a reference to `Object.prototype`'s
      // method instead of failing loudly. `Object.hasOwn` checks only t.args's own keys.
      const declared = Object.hasOwn(t.args, q.arg);
      if (!declared) {
        ctx.addIssue({
          code: "custom",
          path: ["query", i, "arg"],
          message: `"query" entry ${JSON.stringify(q.name)} names arg ${JSON.stringify(q.arg)}, which the tool does not declare`,
        });
      }
      if (seen.has(q.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["query", i, "name"],
          message: `"query" declares ${JSON.stringify(q.name)} twice — the second would silently win`,
        });
      }
      seen.add(q.name);

      // Both checks below are skipped when the arg itself is undeclared — the "does not
      // declare" issue above already covers that case, and `arg.type`/`arg.default` would
      // have nothing real to report on.
      if (!declared) continue;
      const arg = t.args[q.arg]!;

      // Comparing a number or boolean to "" is TS2367 in the generated package, and passing
      // that comparison's operand to `set` is TS2345 — compiled to confirm, not assumed.
      if (q.omitWhen === "empty" && arg.type !== "string") {
        ctx.addIssue({
          code: "custom",
          path: ["query", i, "omitWhen"],
          message:
            `"query" entry ${JSON.stringify(q.name)} sets omitWhen: "empty", but arg ` +
            `${JSON.stringify(q.arg)} declares type ${JSON.stringify(arg.type)} — comparing ` +
            `a ${arg.type} to "" does not typecheck`,
        });
      }

      // omitWhen's guard only omits anything if the value it tests can genuinely be
      // undefined. That requires all three: "optional": true (otherwise the schema demands a
      // value), no "default" (the hoist emits `p.x ?? <default>`, never undefined), and not
      // type "boolean" (isHoisted in args.ts hoists every boolean regardless of default, and
      // renderHoists emits `p.x === true ? "true" : "false"`, also never undefined). `default`
      // alone is not the governing condition — a required or boolean arg is just as dead a
      // guard, and neither can reach this check by way of `default`. No corpus connector
      // combines omitWhen with any of the three: github writes `String(parsed.perPage ?? 30)`
      // unconditionally and guards `page`, which is optional with no default and type number.
      if (q.omitWhen !== undefined) {
        const violations: string[] = [];
        if (!arg.optional) violations.push('is not declared "optional": true');
        if (arg.default !== undefined) violations.push('declares a "default"');
        if (arg.type === "boolean") violations.push('is type "boolean"');
        if (violations.length > 0) {
          ctx.addIssue({
            code: "custom",
            path: ["query", i, "omitWhen"],
            message:
              `"query" entry ${JSON.stringify(q.name)} sets omitWhen, but arg ` +
              `${JSON.stringify(q.arg)} ${violations.join(" and ")} — its value can never be ` +
              "undefined, so the guard can never omit the parameter",
          });
        }
      }
    }
  });

export const EnvSchema = z
  .strictObject({
    vars: z.array(z.string().min(1)).min(1),
    /** Accessor function name. */
    local: identifierField(),
    /** Internal variable name per var. Cosmetic; defaults to camelCase(var). */
    bindings: z.array(z.string().min(1)).optional(),
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
    prefix: z.string().optional(),
    suffix: z.string().optional(),
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
  .refine((e) => e.bindings === undefined || e.bindings.length === e.vars.length, {
    message: '"bindings" must have exactly one entry per "vars" entry',
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
    base: z.string().min(1),
    /**
     * Hoist `base` to a module-scope `const <name> = "<base>";` and reference that const
     * from the emitted helper(s) instead of inlining the literal. mercury spells it `BASE`,
     * bitrise `BITRISE_API`. Omitted inlines the literal, which is what
     * newrelic/datadog/grafana/sentry do.
     */
    baseConst: identifierField().optional(),
    /** Name of an env accessor returning the header record. */
    headers: z.string().min(1).optional(),
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
  });

/**
 * The two styles that emit their own fetch helper and env accessors. `read-only-kit`
 * differs from `hand-rolled` only in the server file's prologue and epilogue (Stage D
 * design §1.2), so every schema rule keyed to "hand-rolled" applies to it unchanged.
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
    serviceLabel: z.string().min(1),
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

export type ConnectorSpec = z.infer<typeof ConnectorSpecSchema> & {
  readonly title: string;
  readonly id: string;
};

/** Capitalise the first letter only: "newrelic" -> "Newrelic". Matches the README fixtures. */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Module-scope registrar constant emitted for `style: "rest-kit"` connectors. */
export function registrarName(spec: ConnectorSpec): string {
  return `register${spec.title.replaceAll(/[^A-Za-z0-9]/g, "")}Tool`;
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

export function parseSpec(input: unknown): ConnectorSpec {
  preflightOutOfScope(input);
  const parsed = ConnectorSpecSchema.safeParse(input);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid connector spec:\n${lines.join("\n")}`);
  }
  const s = parsed.data;
  return { ...s, title: s.title ?? capitalize(s.name), id: s.id ?? `com.nimbus.${s.name}` };
}
