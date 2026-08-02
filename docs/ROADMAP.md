# create-nimbus-connector — Roadmap

`create-nimbus-connector` is the **MIT-licensed generator** for Nimbus MCP connectors. You
describe a connector as a small JSON spec; it emits a package that is byte-identical to what a
Nimbus author would have written by hand.

**North star:** make writing a Nimbus connector a *specification* task rather than a copying
task — for first-party and third-party authors alike, in any language Nimbus supports, with
the generated result provably indistinguishable from a hand-written one.

The gateway's product sequencing lives in the
[Nimbus roadmap](https://github.com/nimbus-agent/Nimbus/blob/main/docs/roadmap.md); the
authoring contract's lives in the
[SDK roadmap](https://github.com/nimbus-agent/nimbus-sdk/blob/main/docs/ROADMAP.md). This
document owns everything generator-shaped.

> **How to read this.** The **[pillars](#pillars)** are the durable areas of investment — the
> *what* and *why*. The **[stages](#stages)** are the execution plan, in order. Stages are
> ordering, not dates. Tasks are `[ ]` not started, `[~]` in progress, `[x]` done.
>
> **Measured results are not repeated here.** Fixture counts and pass rates move every stage
> and a roadmap that restates them goes stale silently. Each stage links its design doc, which
> records what was actually observed.

---

## Pillars

### 1. Fidelity — the output is indistinguishable from hand-written

The generator earns trust by reproducing real connectors byte-for-byte, diffed against a live
Nimbus checkout. Where a diff is irreducible it becomes one of two things: a spec field the
template must expose, or a documented limitation that stays on screen. It never becomes an
edited expectation file.

This is also the pillar that constrains the others. `newrelic`, `datadog`, `grafana` and
`sentry` are locked at 6/6 files, and every new emitter path must be gated on a field those
four never set.

### 2. Coverage — the spec language reaches the whole corpus

Each stage has added a shape the previous one could not express: writes and HITL, OAuth
client-credentials, the `read-only-kit` registration style, search tools. The corpus is the
backlog, and the honest measure of coverage is how many of the 94 connectors could be
regenerated from a spec — not how many features the spec language has.

### 3. Honest verification — no gate that passes while asserting nothing

The strongest checks here exist because a weaker version of them was vacuous. Generated
`sandbox.test.ts` files skip on every CI run; the registry and local-checkout acceptance modes
answer different questions and one must never be reported as the other. Every gate states what
it proves and what it does not. This is a permanent pillar, not a phase.

### 4. Reach — third parties, not just the monorepo

Standalone generation makes a connector that runs anywhere with no Nimbus checkout, resolving
its helpers from the published SDK. The direction of travel is that an external author's
experience is the *default* one rather than the second target.

### 5. One scaffolder for the org

Today two tools scaffold Nimbus connectors. This one converges with and replaces the other —
see [Consolidation](#consolidation).

---

## Consolidation

The org currently ships two connector scaffolders:

| | [`@nimbus-dev/create-connector`](https://github.com/nimbus-agent/nimbus-sdk/tree/main/tools/create-connector) | `create-nimbus-connector` (here) |
| --- | --- | --- |
| Approach | fixed templates | JSON spec → emitted source |
| Languages | TypeScript, Python | TypeScript |
| Output shape | `NimbusExtensionServer` handshake, then MCP | MCP over stdio, the existing corpus shape |
| Starting point | greenfield project | a described connector |
| Verified by | CI generates, installs, builds and runs it | byte-diff against 94 real connectors |

**The intent is that this repository becomes the single scaffolder** and
`@nimbus-dev/create-connector` is eventually retired. Two tools with near-identical names is a
choice users should not have to make.

That is a destination, and it has a price. This generator cannot absorb the other until it can
do three things it currently cannot:

- **[ ] Emit Python.** The whole emitter layer is TypeScript-shaped. This is the largest single
  item on this roadmap and needs its own design.
- **[ ] Emit the handshake shape.** The template tool produces a connector built on
  `NimbusExtensionServer`, which performs contract-version negotiation before serving MCP.
  This generator emits a connector that serves MCP over stdio directly. These are different
  products, not different formatting — supporting both means a second target on the existing
  `GenerateTarget` seam.
- **[ ] Answer `npm create`.** `npm create @nimbus-dev/connector` is a published entry point
  with users. Retiring it means either owning that name or providing a migration that does not
  silently change what people get.

Until all three land, both tools ship and the READMEs cross-link so an author can tell which
one they want. **Nothing here is a deprecation announcement**; it is a stated direction with
its conditions attached.

---

## Stages

### Stage A — monorepo-internal generation `[x]`

The generator, the six-file tree, `--dry-run`, and the golden-fixture diff harness.
[Design](./superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md)

### Stage B — standalone generation `[x]`

Connectors that run outside the monorepo, resolving helpers from
`@nimbus-dev/sdk/connector-kit`; the standalone acceptance harness; published to npm.
[Design](./superpowers/specs/2026-07-30-create-nimbus-connector-stage-b-design.md)

### Stage C — writes, HITL and OAuth `[x]`

`method`, `effect` and `body`; `hitlRequired` in the manifest; `client-credentials`; the
Gateway wiring checklist and its conformance script.
[Design](./superpowers/specs/2026-07-31-create-nimbus-connector-stage-c-design.md)

### Stage D — the `read-only-kit` style and search tools `[~]`

The registration style 60 of the 94 connectors use, and search tools with their seventh
emitted file. Implemented; the registry acceptance gate stays skipped until
[nimbus-sdk#111](https://github.com/nimbus-agent/nimbus-sdk/pull/111) merges and releases the
search kit.
[Design](./superpowers/specs/2026-08-01-create-nimbus-connector-stage-d-design.md)

- [x] `style: "read-only-kit"`
- [x] `impl: "search"`, `rows`, `maxLimit`, `filter`
- [x] `mercury`, `zendesk`, `bitrise` fixtures
- [ ] SDK 1.15.0 released; `standalone-acceptance --registry` runs the search fixtures for real

### Stage E — the corpus tail `[ ]`

The shapes still unreachable, each already measured and documented as a limitation rather than
discovered later:

- [ ] **Bespoke field extractors.** 40 of the 49 filter files hand-write an extractor the
      generator emits a throwing stub for.
- [ ] **Multi-file connectors.** `elasticsearch` and `storybook` split tools into
      `src/tools.ts`; the generator assumes one source file.
- [ ] **Conditional paths and enum arguments.** `bitrise`'s two non-search tools select an
      endpoint from whether an optional arg is present and map a `z.enum` through a lookup.
- [ ] **CLI-backed connectors.** Five connectors shell out via `shared/safe-cli-arg` rather
      than `fetch`.
- [ ] Raise the measured regeneration coverage of the 94-connector corpus, and publish the
      number with its method.

### Stage F — authoring experience `[ ]`

- [ ] **Spec authoring from an OpenAPI document.** The largest reduction in effort available:
      most of a spec is endpoints, arguments and descriptions that an OpenAPI file already has.
- [ ] **`--from-connector`**, deriving a starting spec from an existing connector directory, to
      make regeneration coverage measurable in bulk rather than one hand-written fixture at a
      time.
- [ ] **Better validation errors**, pointing at the JSON path rather than naming the field.
- [ ] A JSON Schema for `ConnectorSpec`, published so editors can complete and validate a spec
      file.

### Stage G — consolidation `[ ]`

The three items under [Consolidation](#consolidation), then retiring
`@nimbus-dev/create-connector` with a migration path.

---

## Non-goals

- **Generating Gateway sync handlers.** They live in `packages/gateway/src/connectors/` and are
  type-coupled to the monorepo. The generator prints a verified checklist of the sites to
  touch instead of guessing at code.
- **Vendoring any Nimbus source.** This repo is MIT and the monorepo is AGPL-3.0-only. The
  harnesses read a checkout at runtime; that constraint is permanent.
- **A Node/npm runtime path.** Bun-only by decision, for the CLI and its output alike. The sole
  exception is `npm publish --provenance` in CI, which is the only way to attach a sigstore
  attestation.
- **Changing what a connector *does*.** Search semantics, the tool-output envelope and the
  manifest vocabulary are Nimbus's to define. This generator reproduces them.
