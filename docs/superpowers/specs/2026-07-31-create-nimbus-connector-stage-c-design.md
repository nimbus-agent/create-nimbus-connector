# create-nimbus-connector — Stage C design

**Status:** implemented on `stage-c-writes`; acceptance results in §9. Three claims in §1 and §4–6 were corrected mid-implementation when measurement contradicted them — each correction is recorded inline rather than rewritten away.
**Date:** 2026-07-31
**Predecessors:** Stage A (generator, monorepo target), Stage B (standalone target, published as `create-nimbus-connector@0.2.2`)

Stage C covers the five items Stages A and B deferred: non-GET HTTP methods, write tools, `hitlRequired`, OAuth, and Gateway wiring.

---

## 1. Ground truth

Everything below was measured against the 94 connectors in `C:\gitrep\Nimbus\packages\mcp-connectors`, not assumed. Three assumptions were falsified in the process, and each would have produced a wrong design.

### 1.1 `hitlRequired` is a manifest-level capability array

| Value | Connectors |
| --- | --- |
| `[]` | 57 |
| `["write", "delete"]` | 23 |
| `["write"]` | 14 |

It is **not** per-tool. It sits at the manifest root beside `permissions` and `syncInterval`.

**Nothing reads it.** The Gateway's extension-manifest parser (`packages/gateway/src/extensions/manifest.ts`) never parses the field. The Gateway *does* have a `hitlRequired`, but it is a different concept — a policy `Set` of action names such as `"db.drop"` and `"git.force_push_main"`, assembled in `platform/assemble.ts`. Emitting the manifest field is honest metadata that matches the corpus; it is not, today, behaviour.

### 1.2 HTTP method is not a proxy for write-intent

34 of 94 connectors issue a non-GET request. Methods: POST 30, PATCH 5, PUT 4, DELETE 3.

Deriving `hitlRequired` from methods matches only **62 of 94**. The 32 mismatches run in both directions:

- **10 connectors declare write capability with no raw non-GET call** — `apple`, `aws`, `azure`, `discord`, `gcp`, `iac`, `imap`, `kubernetes`, `obsidian`, `protonmail`. They write through cloud SDKs or CLIs rather than `fetch`.
- **7 appear to write while declaring `[]`** — `dagster`, `google-photos`, `prefect`, `ramp`, `snyk`, `superset`, `wiz`. On inspection **none of them actually under-declare**: `dagster` POSTs GraphQL *queries*, `superset` POSTs to `/api/v1/security/login`, `prefect` and `snyk` POST to query endpoints, and `ramp` and `wiz` POST to exchange OAuth tokens.

A POST may be a GraphQL query, a login, a token exchange, or a genuine mutation. **Method and write-intent are independent**, and the corpus proves it.

### 1.3 Write helpers are bespoke — byte-matching them is not achievable

Normalising identifiers and string literals across every `async function` containing `method: "POST"` yields **18 distinct skeletons from 18 helpers**. No two are alike.

Compare the read path Stage A was built on: 66/94 identical `package.json`, 84/94 identical `tsconfig.json`, 60/94 sharing `runReadOnlyMcpConnector`. Reads are rigid; writes are not.

Selecting one write connector as a golden fixture would prove only that we can reproduce that one file, and would drag the generator's design toward one arbitrary hand-written shape. Stage C therefore uses a different bar for writes (§5.2) while leaving the read path's bar exactly as it is.

### 1.4 OAuth is one grant type, not a subsystem

Most "OAuth" connectors — `google-drive`, `outlook` — are `requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN")`: a bearer token from the environment, with no flow in the connector. **Stage A already generates these**; only the variable name differs.

Exactly five perform a token exchange — `looker`, `powerbi`, `ramp`, `teams`, `wiz` — and **all five use `client_credentials`**. There are no authorization-code flows and no refresh tokens anywhere in the corpus.

All five POST form-encoded to a token URL and use `Authorization: Bearer` afterwards. They differ in one respect: `ramp` sends credentials as a Basic header; the other four place `client_secret` in the form body.

None reads `expires_in`. All cache for the process lifetime.

### 1.5 Gateway wiring lives in the monorepo, and half of it is not generatable

`packages/gateway/src/connectors/` holds 98 `*-sync.ts` files totalling 17,636 lines. The simplest are ~42 lines: `createXSyncable()` returning a `Syncable` whose `sync()` drains a single list tool via `listConnectorItems` and upserts each item through a per-connector `mapXToItem`.

**Correction, from Task 10's review.** An earlier draft called that "one shape" and treated it as formulaic. It is not: the `listConnectorItems`-draining assembly appears in **exactly two** of the ~98 files (`monte-carlo-sync.ts`, `bigeye-sync.ts`). This spec's original claim came from sampling the shortest files and generalising. The four connectors this project uses as golden fixtures — `newrelic`, `datadog`, `grafana`, `sentry` — are hand-authored with a different structure entirely: direct `fetch`, `readConnectorSecret`, cursor pagination, and an options-object factory.

Two consequences, both applied in §6:

- Emitting a *working* sync implementation would reproduce two specific AGPL files nearly verbatim, which an MIT repository must not do.
- It would also imply a shape that fits 2 of 98 connectors, which is worse than emitting nothing where the answer is unknown.

The `*-mapping.ts` half is bespoke — it maps a service's API response shape into the local index, and no connector spec contains that information.

93 syncables are registered in a single file, `platform/assemble-sync-registrations.ts`, and each API-backed connector also needs an id in `connectors/connector-catalog.ts` (`CONNECTOR_SERVICE_IDS`, alongside a `CONNECTOR_SYNC_INTERVAL_MS` entry that `tsc` enforces stays in step).

`connectors/gateway-syncable-ids.ts` is **not** that list, despite the similar name: it holds four ids — `blame`, `filesystem`, `obsidian`, `openapi` — for local filesystem-backed syncables that have no catalog entry at all.

### 1.6 Two latent defects found while measuring

**`entry` vs `entrypoint`.** The extension-manifest parser reads `o["entry"]` with no fallback; all 94 connectors declare `"entrypoint"`. Consumers then default to `"dist/index.js"` (`install-from-local.ts:725`, `verify-extensions.ts:177`), while every connector builds `dist/server.js`. Installing such a connector records an empty entry hash and later fails verification with `"entry file missing"`.

The 94 are unaffected in practice — they are workspace packages that never traverse `install-from-local`. **Generated standalone connectors are not so lucky**, since being installable is their purpose. 71 tests pin the `dist/index.js` default, so that contract is deliberate and well covered.

`nimbus scaffold extension` (`packages/cli/src/commands/scaffold.ts`) also emits the ignored `entrypoint` key — but pairs it with `dist/index.js`, which happens to equal the default. It works by coincidence rather than by correctness. It additionally emits the legacy `permissions: ["read"]` array form, which the parser flags as `isPreT2Legacy`.

**`hitlRequired` is declared by all 94 and read by none.** Recorded here so the spec does not imply otherwise.

---

## 2. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | All five items in one Stage C, Gateway wiring specified last | User decision, taken with §1.5 known |
| D2 | Separate `method` and `effect` fields | §1.2 — method does not imply write-intent |
| D3 | `effect` is three-valued, not two booleans | Maps onto the only two `hitlRequired` values observed; two booleans admit nonsense states |
| D4 | `hitlRequired` computed from `effect`, never declared | §1.2 — hand-declared capability drifts from the tools; 32 of 94 already have |
| D5 | Args **not referenced in the path** are the body by default; explicit mapping optional and overriding | Matches the observed `JSON.stringify({ issueId, status })` shape. Amended after Task 4's review: the original "all args are the body" sent path parameters in the body too — see §4.4 |
| D6 | Writes verified by golden snapshots of our own output | §1.3 — byte-matching hand-written writers is unachievable |
| D7 | Nimbus accepts `entrypoint` as a fallback for `entry` | Fixes the 94, `nimbus scaffold`, and generated connectors at once |
| D8 | Gateway wiring is opt-in and emits new files only | Editing a 93-entry file in another repository risks silent corruption |
| D9 | `client-credentials` is hand-rolled style only | rest-kit's registrar resolves one bearer credential itself and has no seam for an exchange |

**Backward compatibility constraint:** `create-nimbus-connector@0.2.2` is published. Someone may already have a spec file. Every schema change below is additive, and `impl: "get"` remains accepted.

---

## 3. Schema

### 3.1 Tool fields

```jsonc
{
  "name": "github_issue_create",
  "description": "Create an issue.",
  "impl": "rest",
  "method": "POST",
  "effect": "write",
  "path": "/repos/${arg.owner|enc}/${arg.repo|enc}/issues",
  "args": { "title": { "type": "string", "min": 1 } }
}
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `impl` | `"rest" \| "stub"` | — | `"get"` accepted as a deprecated alias for `"rest"` |
| `method` | `"GET" \| "POST" \| "PUT" \| "PATCH" \| "DELETE"` | `"GET"` | The HTTP verb, nothing more |
| `effect` | `"read" \| "write" \| "delete"` | `"read"` | The author's declaration of intent |
| `body` | `Record<string, string>` | args | Explicit arg-name → API-field-name mapping |

`impl` is renamed because `"get"` became wrong the moment `method` existed. The eight existing fixtures are *inputs*, not golden output, so updating them changes no generated bytes.

### 3.2 Validation

Following the Stage A precedent that the schema must reject anything the emitters cannot render:

- `body` requires `method !== "GET"`.
- `effect: "write" | "delete"` with `method: "GET"` is an error. A REST GET that mutates is a bug, not a design.
- `method: "DELETE"` with `effect: "write"` is **allowed**. Deleting a webhook subscription is not destructive to user data; `effect` is the author's judgement and is deliberately not derived from the verb.
- `body` keys must name declared args; unknown names are rejected at parse time, mirroring the path-template validator.
- `auth: "client-credentials"` requires exactly two `vars` (client id, secret) and `style: "hand-rolled"` (D9).
- `method` and `body` are rejected on `impl: "stub"` tools — a stub issues no request, so neither has anything to describe.

**`effect` on a stub tool is permitted, and does contribute to `hitlRequired`.** A stub is a placeholder for an implementation that will write, and the manifest declares what the connector is *for*. This over-declares rather than under-declares: the failure mode is a human being asked to approve something harmless, not a mutation slipping past review. Stated explicitly because it is genuinely ambiguous — a stub throws and therefore writes nothing.

### 3.3 Manifest

`hitlRequired` is the unique set of non-`read` effects across the tools, emitted in a **fixed capability order — `write` before `delete`** — filtered to those actually present. A read-only spec yields `[]`, byte-identical to today.

The order is a convention of the corpus, not a sort. Re-measured across all 94 manifests (§1.1):

| Value | Connectors |
| --- | --- |
| `[]` | 57 |
| `["write", "delete"]` | 23 |
| `["write"]` | 14 |
| `["delete", "write"]` | **0** |

An earlier draft of this section claimed `delete` before `write` and an alphabetical `.sort()` implemented it. That is wrong in every one of the 23 manifests that declare both, and it would have made this project's headline property — byte-reproducing a real connector — unreachable for every mutating connector in the corpus. The emitter therefore filters a declared `["write", "delete"]` constant rather than sorting; a comparator that "happens to" produce the right order is the defect that was just removed.

---

## 4. Emission

### 4.1 The invariant that protects the golden fixtures

**A write helper is emitted only when the spec contains a non-GET tool.** A read-only spec never reaches that code path, so `newrelic`, `datadog`, `grafana` and `sentry` — the four 6/6 fixtures, all hand-rolled — cannot move. This is byte-safety by construction, not by care.

It also mirrors the corpus: `argocd` has `agPost` *because* it posts.

### 4.2 rest-kit

The emitted rest-kit helper already takes `init?: RequestInit` and spreads it, so it is write-capable unchanged. A write tool passes `{ method, body: JSON.stringify({ ... }) }`.

Worth stating in the generated README: **rest-kit gets writes almost free; hand-rolled needs a second helper.** That is a consequence of shapes the corpus already has, and a reason to prefer rest-kit for new write connectors.

### 4.3 hand-rolled

A second helper is emitted alongside the read one:

```ts
async function zzSend(path: string, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${apiRoot()}${path}`, {
    method,
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // identical status and JSON handling to the read helper
}
```

### 4.4 Bodies

The args **not referenced in the path** become the body, preserving Zod types. An explicit mapping changes key names only: `{ issue_title: title }`, and wins entirely where present — an author who names a path arg there has asked for it deliberately.

Excluding path args was not in the first draft of this spec, which said simply "the args object becomes the body". Reviewing Task 4 exposed what that produces:

| Tool | "args are the body" | Excluding path args |
| --- | --- | --- |
| `POST /items` args `{title}` | `{ title }` | `{ title }` — unchanged |
| `PATCH /items/${arg.id}` args `{id, title}` | `{ id, title }` | `{ title }` |
| `DELETE /items/${arg.id}` args `{id}` | `{ id }` | no body at all |

The middle and bottom rows are the two commonest REST write shapes, and the original rule got both wrong: a PATCH sent its path parameter twice, and a DELETE sent a body it should not have. `parsePathTemplate` already yields which args a path references, so the exclusion is mechanical.

A `DELETE` whose only arg is a path parameter therefore emits neither a `body` field nor a `Content-Type` header.

#### Hoisted args in a body

An arg with a `default`, or of type `boolean`, is *hoisted*: the handler lifts a `const` above the request so the path template can interpolate it. The body has to take a position on those consts, and it is not one position but two.

- **A `default` is a value.** The body must carry the defaulted value, not the raw arg. The first implementation emitted `p.<arg>` unconditionally, so a defaulted arg named in both the path and an explicit `body` mapping put `"all"` in the URL and `undefined` in the JSON — one argument, one call, two values, compiling and running. The body now references the hoisted const where it is in scope.
- **A `boolean`'s hoist is a URL serialisation.** It renders the *string* `"true"`/`"false"`, which is what a query parameter needs and precisely wrong for JSON, where the API distinguishes `true` from `"true"`. The body therefore reaches past the hoist to the raw arg. A boolean in both the path and the body deliberately emits two different expressions; that is one value serialised two ways, not a disagreement.

Scope is not uniform between the two styles, and the rule follows scope rather than style. Hand-rolled builds the body inside the same handler block as the hoists, so they are in scope and are referenced. rest-kit builds it in the registrar's *second* callback — `(parsed) => ({ method, body })` — while the hoists live in the first, so nothing is in scope and the `?? default` is inlined instead. Same value; naming the const there would emit an undeclared identifier.

Finally, **a hoisted const is emitted only if something reads it.** The path reports the args it interpolates, the body reports the hoists it referenced, and only the union is rendered. Without that, a plain `POST` with one `boolean` arg emitted a const no expression read — a `TS6133` under the generated package's own `noUnusedLocals`, and a `noUnusedVariables` error under its own `biome.json`. Both write fixtures now carry a defaulted arg and a boolean arg for exactly this reason: neither did before, so the standalone acceptance run — which is where the generated package's `tsc` and `biome` actually execute — could not see any of this.

### 4.5 `client-credentials`

```jsonc
{
  "vars": ["RAMP_CLIENT_ID", "RAMP_CLIENT_SECRET"],
  "local": "authHeaders",
  "auth": "client-credentials",
  "tokenUrl": "https://api.ramp.com/developer/v1/token",
  "scope": "transactions:read",
  "credentialsIn": "basic"
}
```

Emits the shape all five share: form-encoded POST with `grant_type=client_credentials`, credentials as a Basic header (`"basic"`, as `ramp` does) or in the body (`"body"`, as the other four do), then `Authorization: Bearer` on API calls.

**The emitted token cache honours `expires_in`.** *Superseded.* Stage C originally emitted a module-level cache that never expired, matching `ramp` and `wiz` — correct *only because* connectors are spawned per invocation and are short-lived, which is a property of the caller rather than of this code. That assumption was recorded here rather than relied on silently, and has since been removed: the emitted `token()` reads `expires_in` and renews a little early, so a token cannot lapse mid-flight between the cache check and the request that uses it.

The renewal skew is 60 seconds, halved for tokens shorter than that — a flat 60s skew would treat a 30-second token as already expired and re-exchange on every call. A response with no `expires_in` still caches for the process lifetime, because treating its absence as expiry has the same effect.

Verified by observation, not argument: `scripts/runtime-acceptance.ts` drives a generated connector against a token endpoint minting 2-second tokens and asserts a second exchange occurs, while the long-lived case still yields one exchange for two tool calls. Mutation-tested — restoring the unconditional cache fails exactly those two checks.

There is still no refresh-token flow, and none is planned: no connector in the corpus has one (§1.4).

---

## 5. Testing

### 5.1 The monorepo golden harness is untouched

It still byte-diffs generated output against the real 94. It currently passes 9 fixtures; the two new write fixtures bring it to **11**, and the final fix wave adds `zzwriteonly` for **12** — each declared with expectation `[]`, because no hand-written connector should match a generated write connector, and if one ever did, the harness would report it as "improved" and fail, which is the correct response to an expectation that has gone stale.

`zzwriteonly` is a hand-rolled connector whose only tool mutates. It exists because that is the one shape which must *not* emit a read fetch helper, and nothing else in the project compiled such a package — which is how an unread `async function <local>(path)` shipped. It carries a boolean arg for the same reason. What matters for byte-safety is unchanged by its addition: `newrelic`, `datadog`, `grafana` and `sentry` remain at 6/6.

This remains the strongest evidence the project has, and Stage C's first obligation is not to disturb it.

### 5.2 Golden snapshots of our own output

Write specs generate into `fixtures/snapshots/<name>/`, checked in byte-exact. A test regenerates in memory and compares.

Two failure modes are designed against explicitly, both of which this project has already suffered:

- **Reflexive updating.** Snapshots are worthless if `snapshot:update` is run on every red test. Updating is a separate explicit command that prints a per-file summary; CI only ever compares. A snapshot diff must be read, and the PR must say why the output changed.
- **Vacuous pass.** A missing or empty snapshot directory must fail, not compare nothing — the same shape as Stage A's empty-`checks` array printing success. The test asserts the snapshot set is non-empty and that its file list matches what `generate()` produced, before comparing contents.

**The honest limit:** snapshots prove our output does not change unintentionally. They do not prove it resembles how a human would write that connector, because for writes no such reference exists (§1.3). This is a weaker claim than the read path makes, and it is weaker because the ground truth is weaker.

### 5.3 Standalone acceptance

Three write fixtures join the two existing ones: **50 checks across five fixtures**, proving generated write connectors typecheck, build, and answer `tools/list` against the published SDK.

**New fixtures:** `zzwrite` (hand-rolled — second helper, `client-credentials`, and a `delete`-effect tool, so the `["write","delete"]` manifest path of §3.3 is covered), `zzwriterest` (rest-kit — `init` passthrough), and `zzwriteonly` (hand-rolled, POST only). `zzwriteonly` exists because nothing in the project had ever put a write-only package in front of a real `tsc`: with the read helper emitted unconditionally, such a package emitted an uncalled `async function <local>(path)` and failed its own `typecheck`. Substring assertions could not see it. All three appear in the snapshot set (§5.2) and in the monorepo golden harness with expectation `[]` (§5.1).

Runtime grows roughly linearly with the fixture count — each fixture installs the published SDK and runs a real `tsc` and `bun build`. That is the cost of covering both styles on both paths, and it is paid by a script run on demand rather than by CI (which runs neither acceptance harness — see `ci.yml`).

---

## 6. Gateway wiring

Opt-in via `--gateway-wiring <nimbus-root>`; never part of normal generation. Stage B's premise is that a generated connector needs no Nimbus checkout.

**Emitted (new files), both skeletons rather than implementations:**
- `connectors/<name>-sync.ts` — the `createXSyncable(): Syncable` interface, with `serviceId`, `defaultIntervalMs` and a `sync()` whose **body throws** and documents what must be written. The interface is dictated by the Gateway's own `Syncable` type; the body is deliberately not supplied, because supplying one would reproduce AGPL source and assert a shape that fits 2 of 98 connectors (§1.5).
- Writing refuses if either target file already exists, unless `--force` is passed. `newrelic-sync.ts` and `datadog-sync.ts` are real hand-authored files in the monorepo today, so an unguarded write could destroy one — the same class of silent damage this feature cites as its reason not to auto-edit the registration files.
- `connectors/<name>-mapping.ts` — **a stub that throws**, with the expected signature and a comment naming what must be supplied. The mapping depends on the service's API response shape, which no spec contains. A plausible-looking guess would be worse than nothing.

**Not emitted (edits to existing files):** `platform/assemble-sync-registrations.ts` and `connectors/connector-catalog.ts`. The generator prints the exact lines to paste.

An earlier draft of this spec named `connectors/gateway-syncable-ids.ts` as the second file. That was wrong, and Task 10 caught it: that file holds exactly four ids — `blame`, `filesystem`, `obsidian`, `openapi` — for **local, filesystem-backed** syncables with no catalog entry, and is never consulted for an API-backed connector. Its own header says so. The file a generated connector actually needs an entry in is `connector-catalog.ts` (`CONNECTOR_SERVICE_IDS`, plus the mapped-type `CONNECTOR_SYNC_INTERVAL_MS` that `tsc` enforces stays in step with it). Patching a 93-entry file it does not own, in another repository under another licence, risks silent corruption of someone else's source; a two-line paste is a worse UX and a much better trade.

The licensing boundary holds: output is written into a path the user supplies, and no monorepo source enters this MIT repository.

---

## 7. Sequencing

1. Schema — `method`, `effect`, `body`, `impl: "rest"`
2. Emission — write helper, body construction, `init` passthrough
3. `hitlRequired` computation
4. `client-credentials` auth
5. Snapshots, write fixtures, standalone acceptance
6. **Nimbus: accept `entrypoint` as a fallback for `entry`** — independent of 1–5, so it can run in parallel, but it must ship *and be released* before generated standalone connectors are installable
7. Gateway wiring

Step 6 is the only item whose value lies entirely outside this repository, and it repairs the 94 connectors and `nimbus scaffold` at the same time. It is cleanly separable as a standalone Nimbus PR if preferred.

---

## 8. Out of scope

- Authorization-code and refresh-token OAuth flows. No connector in the corpus uses them (§1.4); adding them would be speculative.
- Generating `*-mapping.ts` bodies (§1.5).
- Editing Nimbus registration files automatically (D8).
- Changing what the Gateway *does* with `hitlRequired`. Stage C emits accurate metadata; making it enforce anything is a Gateway change, not a generator change (§1.1).
- Fixing `nimbus scaffold extension`'s legacy `permissions` array (§1.6). Noted, not owned here.

**Resolved: the URL/body split on an unset optional boolean is correct, and stays.** An *optional boolean with no default* renders `false` in the URL but is **omitted** from the JSON body. Flagged in review as a possible defect; measured, and it is not one.

It is narrower than it first appears. It is reachable only when a spec gives an explicit `body` mapping that re-includes an arg the path already references — with the default body, a path-referenced arg is excluded outright (D5), so the two halves have nothing to disagree about. The divergence exists only where the author deliberately asked for the value in both places.

Each half is right for its medium, and one of them is not ours to choose:

- **URL — `false`.** Byte-locked. `newrelic` is one of the four 6/6 golden fixtures, and the real hand-written connector emits `const only = p.only_open === true ? "true" : "false";`. A query string carries text; the corpus decided what that text is. Changing it drops `newrelic` below 6/6 and the generator stops reproducing the corpus.
- **Body — omitted.** A JSON body carries types, and every API distinguishes a `false` the caller asserted from a key the caller never sent. Emitting `false` for an unset optional would fabricate an assertion the author never made, and would be wrong in precisely the cases where the server's own default is `true`.

Both halves are pinned in `test/emit/server/body.test.ts` so a future "make these consistent" change fails rather than silently breaking one.

---

## 9. Acceptance results

Recorded 2026-07-31, on `stage-c-writes`, Task 11. Every command below was run in this
session against this branch; output is pasted as observed, not summarized or copied from a
plan. `C:\gitrep\Nimbus` and `C:\gitrep\nimbus-sdk` were confirmed clean (`git status --short`)
both before and after the run — `Nimbus` carries only its pre-existing untracked
`facebook-post.txt`, which this project does not own and left alone. No `cnc-*` directory
remained under `%TEMP%` afterward.

**1. `bun test`**

```
bun test v1.3.14 (0d9b296a)

 374 pass
 0 fail
 672 expect() calls
Ran 374 tests across 25 files. [3.25s]
```

Includes `test/golden/snapshots.test.ts` (11 pass), which is Task 11's §5.2 evidence: it
asserts the snapshot file set is non-empty and matches what `generate()` produces for
`zzwrite` and `zzwriterest` before comparing contents, so neither failure mode named in §5.2
(reflexive updating, vacuous pass) is silently possible here.

**2. `bunx tsc --noEmit`**

No output, exit 0.

**3. `bunx biome check src/ test/ scripts/`**

Exit 0. Five pre-existing `lint/complexity/useLiteralKeys` and `lint/style/useTemplate`
**infos** (not errors — `Found 5 infos.`) in `scripts/diff-golden.ts`,
`scripts/standalone-acceptance.ts` and `test/format.test.ts`, unrelated to this task's
changes and unchanged by it.

**4. `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`**

```
PASS  datadog  6/6 files identical
PASS  discord  3/6 files identical (expected partial, 1 stub tool(s))
PASS  google-meet  2/6 files identical (expected partial, 2 stub tool(s))
PASS  grafana  6/6 files identical
PASS  newrelic  6/6 files identical
PASS  sentry  6/6 files identical
PASS  zzscratch  0/6 files identical (expected partial)
PASS  zzstandalone  0/6 files identical (expected partial)
PASS  zzstandalonehand  0/6 files identical (expected partial)
PASS  zzwrite  0/6 files identical (expected partial)
PASS  zzwriterest  0/6 files identical (expected partial)

All fixtures match their declared expectations.
```

11 fixtures, matching §5.1's count exactly (9 carried over from Stage A/B plus the 2 new
write fixtures). This is §5.1's claim, and it is met exactly as scoped: the four hand-rolled
read fixtures (`datadog`, `grafana`, `newrelic`, `sentry`) stay at 6/6; the two write
fixtures (`zzwrite`, `zzwriterest`) are declared `[]` and land at 0/6 — no hand-written
Nimbus connector matches generated write output, which is the expected and correct result,
not a gap.

**5. `bun run acceptance C:/gitrep/Nimbus`**

```
PASS  tsc --noEmit
PASS  biome check
PASS  audit:package-readmes
PASS  monorepo working tree clean
```

**6. `bun run standalone-acceptance --registry`**

```
Mode:        registry (@nimbus-dev/sdk resolved from npm, generated dependency unmodified)
Fixtures:    zzstandalone, zzstandalonehand, zzwrite, zzwriterest

  zzstandalone: installing @nimbus-dev/sdk ^1.11.0 as emitted
  zzstandalonehand: installing @nimbus-dev/sdk ^1.11.0 as emitted
  zzwrite: installing @nimbus-dev/sdk ^1.11.0 as emitted
  zzwriterest: installing @nimbus-dev/sdk ^1.11.0 as emitted
PASS  [zzstandalone] bun install
PASS  [zzstandalone] connector-kit present in node_modules
PASS  [zzstandalone] tsc --noEmit
PASS  [zzstandalone] bun run typecheck
PASS  [zzstandalone] bun run lint
PASS  [zzstandalone] no relative import escapes the package
PASS  [zzstandalone] tools/list over stdio (src)
PASS  [zzstandalone] bun run build
PASS  [zzstandalone] dist/server.js exists after build
PASS  [zzstandalone] tools/list over stdio (dist/server.js)
PASS  [zzstandalonehand] bun install
PASS  [zzstandalonehand] connector-kit present in node_modules
PASS  [zzstandalonehand] tsc --noEmit
PASS  [zzstandalonehand] bun run typecheck
PASS  [zzstandalonehand] bun run lint
PASS  [zzstandalonehand] no relative import escapes the package
PASS  [zzstandalonehand] tools/list over stdio (src)
PASS  [zzstandalonehand] bun run build
PASS  [zzstandalonehand] dist/server.js exists after build
PASS  [zzstandalonehand] tools/list over stdio (dist/server.js)
PASS  [zzwrite] bun install
PASS  [zzwrite] connector-kit present in node_modules
PASS  [zzwrite] tsc --noEmit
PASS  [zzwrite] bun run typecheck
PASS  [zzwrite] bun run lint
PASS  [zzwrite] no relative import escapes the package
PASS  [zzwrite] tools/list over stdio (src)
PASS  [zzwrite] bun run build
PASS  [zzwrite] dist/server.js exists after build
PASS  [zzwrite] tools/list over stdio (dist/server.js)
PASS  [zzwriterest] bun install
PASS  [zzwriterest] connector-kit present in node_modules
PASS  [zzwriterest] tsc --noEmit
PASS  [zzwriterest] bun run typecheck
PASS  [zzwriterest] bun run lint
PASS  [zzwriterest] no relative import escapes the package
PASS  [zzwriterest] tools/list over stdio (src)
PASS  [zzwriterest] bun run build
PASS  [zzwriterest] dist/server.js exists after build
PASS  [zzwriterest] tools/list over stdio (dist/server.js)

All standalone acceptance checks passed.
```

Four fixtures × 10 checks = 40, confirming §5.3's "40 checks across four fixtures" against
the **published** SDK tarball — the strongest of the two modes, per the existing README
section "Two modes".

**7. `bun run standalone-acceptance C:/gitrep/nimbus-sdk`**

Same 4×10 = 40 checks, all `PASS`, against a **local checkout** of the SDK
(`C:\gitrep\nimbus-sdk\sdks\typescript`) rather than the registry tarball — the pre-release
gate mode. Included here because Task 11's brief lists it explicitly; it is not part of the
top-level task instructions' command list, and running it is what "confirm
`C:\gitrep\nimbus-sdk` has a clean working tree" in that instruction presupposes.

### Where a claim had to be qualified rather than asserted outright

- **Snapshots (§5.2) prove non-regression, not resemblance to hand-written code.** The 11
  passing snapshot tests prove `zzwrite` and `zzwriterest` generate byte-identically to their
  checked-in snapshots — i.e., that this project's own output hasn't drifted. They prove
  nothing about whether that output resembles how a human at Nimbus would write the same
  connector, because §1.3 already established there is no single reference shape to compare
  against: normalizing every real write helper in the corpus yields 18 distinct skeletons from
  18 helpers, no two alike. "Passes its own snapshot" and "looks like a real Nimbus write
  connector" are different claims, and only the first is tested.
- **Gateway wiring (§6) is scaffolding, not a working syncable.** `--gateway-wiring` was not
  re-exercised live in this results section (it is covered by `bun test`'s existing CLI/wiring
  suites, part of the 374 passing above); what is recorded here is the honest limit already
  stated in §6 and repeated in the README's new "Gateway wiring" section: both emitted files'
  bodies **throw**. The feature saves the boilerplate of getting the `Syncable` interface shape
  and the two files' scaffolding right; it does not produce a connector that syncs. Anyone
  running it still has to write `sync()` and the mapping function by hand before the
  connector does anything.
