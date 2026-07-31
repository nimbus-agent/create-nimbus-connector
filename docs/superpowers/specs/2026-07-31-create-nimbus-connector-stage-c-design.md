# create-nimbus-connector — Stage C design

**Status:** approved, not yet implemented
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

`packages/gateway/src/connectors/` holds 98 `*-sync.ts` files totalling 17,636 lines. The simplest are ~42 lines and follow one shape: `createXSyncable()` returning a `Syncable` whose `sync()` drains a single list tool via `listConnectorItems` and upserts each item through a per-connector `mapXToItem`.

The `*-mapping.ts` half is bespoke — it maps a service's API response shape into the local index, and no connector spec contains that information.

93 syncables are registered in a single file, `platform/assemble-sync-registrations.ts`, with a parallel id list in `connectors/gateway-syncable-ids.ts`.

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

`hitlRequired` is the sorted unique set of non-`read` effects across the tools, `delete` before `write` — matching all 37 manifests that declare them. A read-only spec yields `[]`, byte-identical to today.

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

**The emitted token cache is module-level and never expires.** This matches `ramp` and `wiz`, and is correct *only because* connectors are spawned per invocation and are short-lived. No connector in the corpus reads `expires_in`. Should connectors ever become long-lived, every one of these silently begins using a stale token. The assumption is recorded here because the code depends on it and does not state it.

---

## 5. Testing

### 5.1 The monorepo golden harness is untouched

It still byte-diffs generated output against the real 94. It currently passes 9 fixtures; the two new write fixtures bring it to **11**, each declared with expectation `[]` — no hand-written connector should match a generated write connector, and if one ever did, the harness would report it as "improved" and fail, which is the correct response to an expectation that has gone stale.

This remains the strongest evidence the project has, and Stage C's first obligation is not to disturb it.

### 5.2 Golden snapshots of our own output

Write specs generate into `fixtures/snapshots/<name>/`, checked in byte-exact. A test regenerates in memory and compares.

Two failure modes are designed against explicitly, both of which this project has already suffered:

- **Reflexive updating.** Snapshots are worthless if `snapshot:update` is run on every red test. Updating is a separate explicit command that prints a per-file summary; CI only ever compares. A snapshot diff must be read, and the PR must say why the output changed.
- **Vacuous pass.** A missing or empty snapshot directory must fail, not compare nothing — the same shape as Stage A's empty-`checks` array printing success. The test asserts the snapshot set is non-empty and that its file list matches what `generate()` produced, before comparing contents.

**The honest limit:** snapshots prove our output does not change unintentionally. They do not prove it resembles how a human would write that connector, because for writes no such reference exists (§1.3). This is a weaker claim than the read path makes, and it is weaker because the ground truth is weaker.

### 5.3 Standalone acceptance

Two write fixtures join the two existing ones: **40 checks across four fixtures**, proving generated write connectors typecheck, build, and answer `tools/list` against the published SDK.

**New fixtures:** `zzwrite` (hand-rolled — second helper and `client-credentials`) and `zzwriterest` (rest-kit — `init` passthrough). Both carry a `delete`-effect tool so the `["delete","write"]` manifest path is covered. Both also appear in the snapshot set (§5.2) and in the monorepo golden harness with expectation `[]` (§5.1).

Runtime roughly doubles, to ~40s. That is the cost of covering both styles on both paths, and it is paid by a script run on demand rather than by CI (which runs neither acceptance harness — see `ci.yml`).

---

## 6. Gateway wiring

Opt-in via `--gateway-wiring <nimbus-root>`; never part of normal generation. Stage B's premise is that a generated connector needs no Nimbus checkout.

**Emitted (new files):**
- `connectors/<name>-sync.ts` — the formulaic `createXSyncable()` draining one list tool.
- `connectors/<name>-mapping.ts` — **a stub that throws**, with the expected signature and a comment naming what must be supplied. The mapping depends on the service's API response shape, which no spec contains. A plausible-looking guess would be worse than nothing.

**Not emitted (edits to existing files):** `platform/assemble-sync-registrations.ts` and `connectors/gateway-syncable-ids.ts`. The generator prints the exact lines to paste. Patching a 93-entry file it does not own, in another repository under another licence, risks silent corruption of someone else's source; a two-line paste is a worse UX and a much better trade.

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
- Token expiry handling (§4.5).
- Generating `*-mapping.ts` bodies (§1.5).
- Editing Nimbus registration files automatically (D8).
- Changing what the Gateway *does* with `hitlRequired`. Stage C emits accurate metadata; making it enforce anything is a Gateway change, not a generator change (§1.1).
- Fixing `nimbus scaffold extension`'s legacy `permissions` array (§1.6). Noted, not owned here.
