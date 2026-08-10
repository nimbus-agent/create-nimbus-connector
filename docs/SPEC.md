# The spec language, field by field

Every field `ConnectorSpecSchema` accepts: its type, whether it is required, its default, and
the constraints the schema itself enforces.

**This page is generated.** `bun run build:spec-doc` rewrites it from
[`schema/connector-spec.schema.json`](../schema/connector-spec.schema.json), which is itself
generated from `ConnectorSpecSchema`, and `test/spec-doc.test.ts` byte-compares the checked-in
file against a fresh build — so this page cannot drift from the language it describes, and it
cannot describe a different language from the published schema. Edit
`scripts/_lib/build-spec-doc.ts`, not this file.

This is the index of what exists. How the fields work together — writes, search tools, the three
styles, the OAuth exchange, the reserved identifiers — is [SPEC-RULES.md](./SPEC-RULES.md), and
[USAGE.md](./USAGE.md) walks through writing a spec from scratch.

## How to read a table

- **Field** — the key as a spec file writes it. **(required)** means the schema demands it;
  everything else may be omitted.
- **Type** — the accepted shape. A list of literals is the set of accepted values, and `object`
  links to that field's own table below.
- **Default** — the default the schema document carries. Where a field is filled in by
  `parseSpec` instead, or where the conversion to JSON Schema drops the default, this column
  reads `—` and the last column says what the value is.
- **Rules** — every constraint the schema carries for that field, including the ones on its
  items, on a record's keys and values, and on each branch of a union.

## What this page cannot tell you

A field-by-field reference cannot express *"only valid when that other field is set to this"* —
the rule belongs to no single row. `ConnectorSpecSchema` carries a long list of such rules,
written as `.refine`/`.superRefine` clauses, and `validateSpec` adds the reserved-identifier
pass on top of them. None of them is on this page, for the same reason none of them is in the
published JSON Schema this page is generated from:

> Refinements enforced by `parseSpec` and `validateSpec` (cross-field rules, reserved identifiers, style-specific requirements) cannot be expressed in JSON Schema and are **not** represented here. A spec that validates against this schema may still be rejected by the generator.

They are not hand-copied here on purpose. A prose copy of the acceptance rules is a second
source of truth for the spec language, and it goes stale in days — two fields grew a new
content rule while the JSON Schema was being written. Read them where they are enforced:

- [`src/spec.ts`](../src/spec.ts) — every `.refine`/`.superRefine` on `ArgSchema`, `ToolSchema`,
  `EnvSchema`, `FetchHelperSchema` and `ConnectorSpecSchema`, each carrying its own message and
  the reasoning behind it.
- [`src/validate.ts`](../src/validate.ts) — `RESERVED_IDENTIFIERS` and the identifier-collision
  rules, which are a second pass, after `parseSpec` has returned.
- [`test/schema.test.ts`](../test/schema.test.ts) — concrete specs that validate against the
  schema and are then refused by the generator, pinning the gap rather than describing it.
- [`docs/SPEC-RULES.md`](./SPEC-RULES.md) — the same rules in prose, grouped by the feature they
  belong to.

`bun src/cli.ts --spec <path> --dry-run` is what tells you a spec is actually accepted.

## `ConnectorSpec`

| Field | Type | Default | Rules | What it is |
| --- | --- | --- | --- | --- |
| `name` **(required)** | `string` | — | matches `^[a-z0-9-]+$` | The connector's name, lower-kebab-case. It names the default output directory, the generated package (`nimbus-mcp-<name>`), and is what `title` and `id` default from. |
| `title` | `string` | — | minLength 1 | The service's name as it appears in emitted identifiers — `register<Title>Tool`, `create<Title>Syncable`, `<Title>SearchMatchOptions` — with non-alphanumerics stripped, and in the generated README's prose. `parseSpec` fills it with `name` capitalised, after the schema has run, which is why no default shows here. |
| `displayName` **(required)** | `string` | — | minLength 1 | The manifest's `displayName`. |
| `id` | `string` | — | minLength 1 | The manifest's `id`. `parseSpec` fills it with `com.nimbus.<name>`, after the schema has run, which is why no default shows here. |
| `description` **(required)** | `string` | — | minLength 1 | The manifest's `description`. |
| `serviceLabel` **(required)** | `string` | — | minLength 1 | The service's name as two emitted positions read it: the error message for a non-2xx response, ``throw new Error(`<serviceLabel> ${status}: …`)``, and a block comment in the Gateway wiring. |
| `style` | `"rest-kit" \| "hand-rolled" \| "read-only-kit"` | `"rest-kit"` | — | How the connector registers its tools, and the field with the widest blast radius in the language. [SPEC-RULES § Styles](./SPEC-RULES.md#styles-rest-kit-hand-rolled-read-only-kit). |
| `handlerStyle` | `"concise" \| "block"` | `"concise"` | — | How a REST tool's handler is written: `concise` is an expression-bodied arrow, `block` a statement body with an explicit `return`. A stub or search handler always has a block body. |
| `argsSchemaStyle` | `"inline" \| "expanded"` | `"inline"` | — | How a tool's `z.object({…})` argument schema is printed: on one line, or one field per line. `z.object({})` is always one line. |
| `network` | `string[]` | `[]` | — | The manifest's `permissions.network` — the hosts the connector may reach. |
| `filesystem` | [object](#filesystem) | — | — | The manifest's `permissions.filesystem`. Omitted leaves the key out of the manifest entirely, which is a different statement from declaring it empty. |
| `syncInterval` | `integer` | `300` | exclusiveMinimum 0, maximum 9007199254740991 | The manifest's `syncInterval`, in seconds. The Gateway wiring multiplies it by 1000 for its `defaultIntervalMs`. |
| `minNimbusVersion` | `string` | `"0.2.0"` | — | The manifest's `minNimbusVersion`. |
| `env` | [object[]](#env) | `[]` | — | The environment variables the connector reads, grouped into the accessors the emitter declares. |
| `fetchHelper` **(required)** | [object](#fetchhelper) | — | — | The fetch helper the tools issue their requests through: its name, its base URL and its headers. |
| `tools` | [object[]](#tools) | — | — | The tools the connector registers. `parseSpec` fills it with `[]` when it is absent. |

## `filesystem`

| Field | Type | Default | Rules | What it is |
| --- | --- | --- | --- | --- |
| `read` | `string[]` | `[]` | — | The manifest's `permissions.filesystem.read`. |
| `write` | `string[]` | `[]` | — | The manifest's `permissions.filesystem.write`. |

## `env[]`

| Field | Type | Default | Rules | What it is |
| --- | --- | --- | --- | --- |
| `vars` **(required)** | `string[]` | — | minItems 1, items minLength 1 | The environment variables this entry reads, in order. |
| `local` **(required)** | `string` | — | matches `^[A-Za-z_$][A-Za-z0-9_$]*$` | The accessor function the emitter declares for this entry. |
| `bindings` | `string[]` | — | items matches `^[A-Za-z_$][A-Za-z0-9_$]*$` | The const each var is read into inside the accessor body, one per `vars` entry. Defaults to the camelCase of the variable's name. |
| `required` | `boolean` | `false` | — | Whether the accessor throws when a variable it reads is unset or empty. An `auth` mode emits the same guard. |
| `default` | `string` | — | — | Substituted when the variable is unset or empty — the accessor reads `process.env[…]?.trim() \|\| <default>` and needs no guard. |
| `transform` | `"stripTrailingSlash" \| "trimTrailingSlashFn"` | — | — | How a trailing slash is stripped from a user-supplied base URL: `stripTrailingSlash` inlines `.replace(/\/$/, "")`, `trimTrailingSlashFn` emits the shared `trimTrailingSlash` helper once and calls it. |
| `prefix` | `string` | — | — | Text placed before the accessor's value, spliced raw into the template literal — and, for `auth: "basic"`, before the username passed to `encodeBasicAuthHeader`. |
| `suffix` | `string` | — | — | Text placed after the accessor's value, in the same two positions as `prefix`. |
| `auth` | `"bearer" \| "basic" \| "headers" \| "client-credentials"` | — | — | Which auth wrapper the accessor's value is built into. Omitted means the accessor returns the value itself. |
| `headerNames` | `string[]` | — | items minLength 1 | The header name each variable's value is sent under. |
| `tokenLocal` | `string` | — | matches `^[A-Za-z_$][A-Za-z0-9_$]*$` | Splits the accessor in two: a `(): string` of this name that reads and guards the raw token, leaving `local` a wrapper that builds the header from a call to it. |
| `tokenUrl` | `string` | — | format `uri` | The token endpoint the client-credentials exchange POSTs to. |
| `scope` | `string` | — | minLength 1 | The `scope` sent with the client-credentials exchange. |
| `credentialsIn` | `"basic" \| "body"` | — | — | Where the client id and secret go: an `Authorization: Basic` header, or the form body as `client_id`/`client_secret`. |

## `fetchHelper`

| Field | Type | Default | Rules | What it is |
| --- | --- | --- | --- | --- |
| `local` **(required)** | `string` | — | matches `^[A-Za-z_$][A-Za-z0-9_$]*$` | The name of the fetch helper the emitter declares, and that a REST or search tool's handler calls. |
| `base` **(required)** | `string` | — | minLength 1 | The base URL. A template over `${env.X}`, which `resolveEnvRefs` rewrites to a call to that accessor before emission. |
| `baseConst` | `string` | — | matches `^[A-Za-z_$][A-Za-z0-9_$]*$` | Hoist `base` to a module-scope `const` of this name and reference it from the helper, instead of inlining the literal. |
| `headers` | `string` | — | matches `^[A-Za-z_$][A-Za-z0-9_$]*$` | Names an env accessor returning the header record. Emitted as a call — `headers: <name>()`. |
| `inlineHeaders` | `Record<string, string>` | — | — | A literal header object. A value that is exactly `${env.NAME}` is resolved to that accessor's call; every other value is JSON-quoted as written. |
| `normalizeLeadingSlash` | `boolean` | `false` | — | Give the helper a `pathPart` local that prepends `/` to a path that does not start with one. |
| `jsonFallbackRaw` | `boolean` | `false` | — | Return `{ raw: text }` for a response body that does not parse as JSON, instead of letting `JSON.parse` throw. |
| `staticPathStyle` | `"quoted" \| "template"` | `"quoted"` | — | How a fully-static path renders at a call site: quoted, or a backtick template literal. |

## `tools[]`

| Field | Type | Default | Rules | What it is |
| --- | --- | --- | --- | --- |
| `name` **(required)** | `string` | — | minLength 1 | The tool's name, as MCP registers it. |
| `description` **(required)** | `string` | — | minLength 1 | The tool's description, as MCP registers it. |
| `args` | [Record<string, object>](#toolsargsname) | `{}` | keys matches `^[A-Za-z_$][A-Za-z0-9_$]*$` | The tool's arguments, keyed by the name the generated schema declares. |
| `path` | `string` | — | — | The request path, a template over `${env.X}` and `${arg.X}` with an optional `\|raw`, `\|enc`, `\|num` or `\|bool` mode. |
| `query` | [object[]](#toolsquery) | — | minItems 1 | Query-string parameters built beside `path`, each emitted as a `searchParams.set` call — the only way to express a parameter that is sent conditionally. [SPEC-RULES § Conditional query parameters](./SPEC-RULES.md#conditional-query-parameters-query). |
| `pathWhen` | [object[]](#toolspathwhen) | — | minItems 1 | Guards evaluated in order before `path`, each selecting a different endpoint when its named argument is absent. `path` is the final unguarded return. [SPEC-RULES § Conditional endpoints](./SPEC-RULES.md#conditional-endpoints-pathwhen). |
| `impl` | `"rest" \| "get" \| "stub" \| "search"` | `"rest"` | — | What the tool does: a REST request, a handler that throws `"<tool> not implemented"`, or a substring search over one endpoint's rows. `get` is the Stage A spelling of `rest`, normalised at parse time. |
| `method` | `"GET" \| "POST" \| "PUT" \| "PATCH" \| "DELETE"` | `"GET"` | — | The HTTP verb, and nothing more. |
| `effect` | `"read" \| "write" \| "delete"` | `"read"` | — | The author's declaration of intent. The manifest's `hitlRequired` is the deduplicated set of non-`read` effects, and is deliberately not derived from `method`. |
| `body` | `Record<string, string>` | — | keys minLength 1, values minLength 1 | Argument name → the field name the request body sends it as. Omitted sends every argument the URL does not already carry. |
| `rows` | `string` | — | matches `^[A-Za-z_$][A-Za-z0-9_$]*$` | The property a search tool plucks from the response envelope. Omitted means the response is itself the array. |
| `maxLimit` | `integer` | `100` | exclusiveMinimum 0, maximum 9007199254740991 | A search tool's per-connector result cap. |
| `filter` | [object](#toolsfilter) | — | — | The search filter emitted into `src/search-filter.ts`. [SPEC-RULES § Search tools](./SPEC-RULES.md#search-tools-impl-search-rows-maxlimit-and-filter). |

## `tools[].args.<name>`

| Field | Type | Default | Rules | What it is |
| --- | --- | --- | --- | --- |
| `type` **(required)** | `"string" \| "number" \| "boolean"` | — | — | The argument's type. |
| `optional` | `boolean` | `false` | — | Whether the caller may omit the argument. |
| `default` | `string \| number \| boolean` | — | — | The value the emitted hoist substitutes when the argument is absent. |
| `local` | `string` | — | matches `^[A-Za-z_$][A-Za-z0-9_$]*$` | The hoisted const's name. Defaults to the argument's own key. |
| `min` | `number` | — | — | Emitted as `.min(…)` on the argument's zod schema. |
| `max` | `number` | — | — | Emitted as `.max(…)` on the argument's zod schema. |
| `int` | `boolean` | `false` | — | Emitted as `.int()` on a number argument's zod schema. |

## `tools[].query[]`

| Field | Type | Default | Rules | What it is |
| --- | --- | --- | --- | --- |
| `name` **(required)** | `string` | — | minLength 1 | The query key as the API spells it — deliberately not an identifier check, since `page[size]` is a real corpus key. |
| `arg` **(required)** | `string` | — | minLength 1 | The tool's argument supplying the value. |
| `omitWhen` | `"absent" \| "empty"` | — | — | Guards the emitted `searchParams.set`: `absent` tests `!== undefined`, `empty` adds `&& !== ""`. Omitted sends the parameter unconditionally. |

## `tools[].pathWhen[]`

| Field | Type | Default | Rules | What it is |
| --- | --- | --- | --- | --- |
| `absent` **(required)** | `string` | — | minLength 1 | The argument tested; this rung wins when it is `undefined`. |
| `path` **(required)** | `string` | — | minLength 1 | The path to use when `absent` is undefined, in the same template DSL as `tools[].path`. |

## `tools[].filter`

| Field | Type | Default | Rules | What it is |
| --- | --- | --- | --- | --- |
| `export` **(required)** | `string` | — | matches `^[A-Za-z_$][A-Za-z0-9_$]*$` | The `export const` this filter is emitted as in `src/search-filter.ts`. |
| `fields` | `(string \| { path: string[] } \| { tags: "text" \| "objects" })[]` | — | minItems 1, items variant 1 minLength 1, items variant 2 `path` items minLength 1 | The fields each row is matched on, in three entry kinds: a plain key, a nested `path` of two or more segments, or a `tags` entry. Omitted emits a throwing stub typed as `SearchFilter` for you to replace. |
| `tags` | `boolean` | `false` | — | Also match tag names, by appending `tagText(row)` after the keyed fields. |
