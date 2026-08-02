# Conditional query parameters — design

**Date:** 2026-08-02
**Stage:** E — the corpus tail, the "conditional paths" bullet (query parameters only)
**Status:** approved, not yet implemented

## Problem

A tool's query string is written inside `path` today, and that works: `datadog`, `grafana`,
`dependencytrack` and `bitrise` all carry one, and two of them are locked byte-exact fixtures.

What `path` cannot express is a parameter that is **omitted** when its argument is absent. The
corpus writes that with a `URL` and `searchParams`:

```ts
(parsed) => {
  const lim = parsed.limit ?? 50;
  const u = new URL(`${DISCORD_API}/channels/${encodeURIComponent(parsed.channelId)}/messages`);
  u.searchParams.set("limit", String(lim));
  if (parsed.after !== undefined && parsed.after !== "") {
    u.searchParams.set("after", parsed.after);
  }
  return `${u.pathname}${u.search}`;
}
```

A path template renders one fixed string, so a tool needing this shape must be stubbed. It is
why `discord` and `google-meet` do not reach zero diff, and the ROADMAP already records
conditional query parameters as the single most common reason a fixture stubs a tool.

**Measured:** six connectors use the uniform shape — `circleci`, `discord`, `github`,
`github-actions`, `google-meet`, `google-photos`. A seventh, `gitlab`, uses the harder
lookup-table form and is out of scope.

> A caution on that six. Two different pattern-matches over the corpus disagreed with each
> other (11 vs 7) while scoping this. Six is the count from the tighter of the two and is
> good enough to justify the work, but it has **not** had the read-every-file treatment the
> extractor measurement got. Do not publish it as a corpus figure without that pass; see
> ROADMAP's *Measuring reach* for why counts derived this way have been wrong before.

## Goal

Emit the `URL` + `searchParams` shape for tools that declare conditional query parameters, and
stop stubbing them. Do not disturb the existing mechanism: unconditional query strings stay in
`path` and keep byte-matching exactly as they do today.

## Scope

**In:** query parameters that are unconditionally set, or omitted when their argument is absent
or empty.

**Out, and tracked separately:** `bitrise`-style *endpoint* selection (branching on argument
presence to choose between `/v0.1/me/apps` and `/v0.1/apps/<slug>/builds`) and `z.enum`
arguments mapped through a lookup table into a numeric parameter. Those are a different
problem — control flow over the path itself rather than over one parameter — and the ROADMAP
bullet covering them stays open.

**Also out: repeating (multi-value) parameters.** `?labelIds=a&labelIds=b` needs
`searchParams.append` inside a loop rather than `set`. This is a real corpus shape — `gmail`
writes it, at `gmail/src/server.ts:77` and again at `:101-104` — but none of the six connectors
in scope uses it, and it needs an argument typed as an array, which `ArgSchema` has no form
for. Adding `set`-only now does not foreclose it: `append` would be a further `omitWhen`-style
field on the same entry, not a redesign.

## Spec language

`ToolSchema` gains an optional `query`:

```jsonc
"path": "/channels/${arg.channelId|enc}/messages",
"query": [
  { "name": "limit", "arg": "limit" },
  { "name": "after", "arg": "after", "omitWhen": "empty" }
]
```

Three fields:

- **`name`** — the query key as the API spells it. Not required to be a JS identifier;
  `page[size]` is a real corpus key.
- **`arg`** — the declared argument supplying the value.
- **`omitWhen`** — optional, and `"empty"` is the only accepted value. It renders the guard
  `!== undefined && !== ""`. A single-valued enum rather than a boolean because the guard is a
  specific predicate, not a yes/no: if a second predicate ever appears in the corpus it becomes
  another value here rather than a second boolean field.

### Defaults are deliberately absent

A default belongs to the argument (`"default": 50`), not to the query entry. The existing hoist
machinery already emits `const lim = p.limit ?? 50;` for any argument declaring one, and
`ArgSchema.local` already names that const. Repeating the default in `query` would give one
value two sources of truth that could disagree.

This is also what makes `discord` byte-reachable with no new machinery: its `lim` is exactly
`ArgSchema`'s existing `local`.

## Rendering

| Spec shape | Emission |
| --- | --- |
| `query` absent | today's path expression, unchanged |
| `query` present | `new URL(<base><path>)`, one `searchParams` statement per entry, `` return `${u.pathname}${u.search}` `` |

### The URL is absolute, and the base comes from `baseExpr`

`new URL("/channels/123")` throws `TypeError: Invalid URL` — a relative reference needs a base.
The corpus never hits this because it always builds an **absolute** URL and strips it back
afterwards. All six connectors do it the same way:

```ts
const u = new URL(`${DISCORD_API}/channels/${encodeURIComponent(parsed.channelId)}/messages`);
…
return `${u.pathname}${u.search}`;
```

The emitter must therefore prefix the path with the base, and it must do so through the
existing `baseExpr(spec)` in `src/emit/server/fetch-helper.ts` — which already yields `${BASE}`
when `fetchHelper.baseConst` is declared and the resolved literal otherwise. That helper exists
precisely so the read helper, the write helper and the rest-kit helper cannot disagree about
which form the base takes; a fourth call site must not reintroduce the disagreement.

**One gate to re-examine while implementing.** `renderBaseConst` emits the module-scope const
only when a fetch helper is emitted, because a spec whose tools are all stubs would otherwise
declare a const nothing reads — a `noUnusedLocals` error in the generated package. A `query`
tool is a third reader of that const. The combination looks unreachable (a `query` tool is not
a stub, and a non-stub tool emits a helper), but the gate's own comment insists the question be
asked of what is actually emitted rather than restated, so the implementation must confirm it
rather than assume it.

**Consequence for the `discord` fixture:** it currently declares no `baseConst`, so `baseExpr`
would inline the literal where the real connector writes `${DISCORD_API}`. Byte-matching
`discord` requires adding `"baseConst": "DISCORD_API"` to its fixture spec. That is a fixture
change, not a design constraint.

### Encoding

`URLSearchParams.set` percent-encodes both key and value. Query values therefore take **no**
encoding mode — there is no `|enc` to apply, because a query entry names an argument rather
than embedding a path-template placeholder. Applying `encodeURIComponent` as well would
double-encode. Path segments keep their modes, unchanged.

Per entry:

- no `omitWhen` → `u.searchParams.set("<name>", String(<value>));`
- `omitWhen: "empty"` → the three-line `if` guard around the same `set`

`<value>` is the hoisted local when the argument declares a default, otherwise the parameter
reference (`p.after`). That choice is not new — it is what `renderPath` already does for path
segments, and reusing it keeps one rule for how an argument becomes an expression.

`String(...)` wraps the unconditional form only; the guarded form does not. That asymmetry is
the corpus's, not a choice — verified directly against `discord/src/server.ts`, whose guarded
`after` is written bare (`u.searchParams.set("after", parsed.after)`). An unconditional entry
may carry a number (`limit`), so it needs the wrap; every guarded entry in the six in-scope
connectors is already a string, so wrapping it would emit `String(parsed.after)` where the real
file writes `parsed.after`.

### The byte-safety invariant

`newrelic`, `datadog`, `grafana` and `sentry` declare no `query`, so they cannot reach the new
branch. The gate is structural, not a matter of remembering to check — the same property that
protected them through the extractor work.

`datadog` and `grafana` do carry `?` inside `path`, and that path stays on the unchanged
branch. Nothing about this design touches it.

## Identifier safety

`u` and `URL` join `RESERVED_IDENTIFIERS` in the same change.

`u` is not the same hazard `root` is reserved for. `root` is a true use-before-declaration:
`renderSearchTool` emits `const root = await <fetchHelper.local>(...)`, so a fetch helper named
`root` makes the initializer reference its own not-yet-initialized binding. `u`'s initializer,
`const u = new URL(<path>)`, never mentions the fetch helper — it constructs cleanly. The hazard
is one statement later: the hand-rolled handler then calls `await <fetchHelper.local>(path)` in
the same scope, so a fetch helper named `u` shadows the URL const, and that call resolves to the
URL value instead of the function — a wrong-target call (`u is not callable` at `tsc`), not a
use-before-declaration. In the rest-kit branch this never fires, since the path callback never
references the fetch helper (it lives in the module-scope factory instead), but the reservation
stays unconditional — `RESERVED_IDENTIFIERS` is a flat set checked before any style is
considered.

`URL` is a global the emitted code calls directly (`new URL(...)`), joining `fetch`, `JSON`,
`String` and the others already listed for that reason — the same shadow risk as those, not the
use-before-declaration risk `root` is reserved for.

## Rejections

Each is a parse-time error naming the offending field:

- **`query` on `impl: "stub"`.** A stub issues no request, so a query string has nothing to
  describe — the same rule `method` and `body` already follow.
- **`query.arg` naming an undeclared argument.** The message names the tool and the argument,
  matching how path-template argument references already fail.
- **A duplicate `name` within one tool's `query`.** Two entries writing one key means the second
  silently wins, which is invisible in the emitted file.
- **`query` present while `path` contains `?`.** Two mechanisms writing one query string is the
  ambiguity class the DSL already rejects `{id}` and `/:id` for. When a tool needs `query`, its
  whole query string moves there.
- **An empty `query` array.** Consistent with `fields`: an empty list expresses nothing and is
  more likely a mistake than an intent.

## What this closes

Three of the five tools our fixtures currently stub: `discord_channel_messages`,
`google_meet_list`, `google_meet_search`.

`discord` is expected to byte-match. **`google-meet` is expected not to**, and that is
accepted rather than fixed: it inlines its default —
`u.searchParams.set("pageSize", String(parsed.pageSize ?? 50))` — where the emitter hoists,
because the existing rule hoists any argument declaring a default. Reaching it would need a
per-argument "inline this default" knob whose only purpose is reproducing a formatting choice,
which is the same trade this project declined for the extractor guard, form and name. It is
documented as shape variance instead.

`bitrise`'s two stubs are untouched.

## Testing

- Unit tests per rendering-table row, including that a `query`-free tool emits byte-identical
  output to today.
- A rejection test per new validator error, each asserting the offending name appears.
- An emitted-typecheck case for a tool with both a conditional and an unconditional parameter,
  so the `URL`/`searchParams` shape is compiled rather than only string-compared.
- `discord`'s fixture converts its stub to a real tool; its `expectations.json` entry is
  re-derived from what the harness reports, never edited toward a hoped-for result.

Generated `test/sandbox.test.ts` remains not evidence — it skips on every run.

## Gates

`bun test`, `bunx tsc --noEmit`, `bunx biome check src/ test/ scripts/`, and
`bun run diff:golden --nimbus-root <path>` with the four locked fixtures still `6/6`,
`mercury`/`zendesk` `6/7`, `dependencytrack` `5/7`, `netlify` `4/7`, and `discord` at or above
its current `3/6`.

## Considered and declined

- **Extending the path string DSL** with optionality and default markers
  (`${arg.after|enc?}`, `${arg.limit|num=50}`). Declined: it encodes control flow as
  punctuation, `?` and `=` would each mean two things, and query-versus-path would stop being
  structurally distinguishable. The DSL already rejects `{id}` and `/:id` because ambiguous
  path syntax caused real bugs.
- **Setting every parameter unconditionally**, letting absent ones render empty. Declined
  because it changes the request: `?after=` is not `?after` omitted, several APIs treat an
  empty cursor differently from no cursor, and every corpus connector guards.
- **A `default` field on the query entry.** Declined as a second source of truth for a value
  the argument already carries.
- **An "inline this default" knob** to reach `google-meet`'s form. Declined as a formatting
  reproduction knob, consistent with the extractor guard/form/name decisions.
- **Adding `!== null` to the `omitWhen: "empty"` guard.** Declined: `null` is unreachable.
  `ArgSchema` types an argument `string`, `number` or `boolean`, and zod's `.optional()` widens
  to `| undefined`, never `| null` — a JSON `null` fails the schema before a handler runs. All
  six in-scope connectors guard on `!== undefined && !== ""` and nothing else, so adding a
  third clause would emit a check that can never fire *and* forfeit every byte match it was
  added to protect.
- **Renaming the emitted URL local from `u`** to something less collision-prone
  (`urlObj`, `__url`). Declined, though the concern behind it is fair. The corpus is genuinely
  split — across all connectors the name is `search` ×23, `u` ×20, `params` ×15, `qs` ×10,
  `body` ×2, `q` ×1 — so any choice matches some files and not others, exactly like the
  registrar naming and the transport tail. `u` is what `discord` and `google-meet` write, which
  is the only reason it wins: it is the one that byte-matches the fixtures this work targets.
  A hygienic name would match nothing. Reserving `u` costs a spec author one rename of their
  own identifier; not emitting `u` costs every byte match this design exists to obtain.
