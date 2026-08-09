# Consolidation — one scaffolder for the org

The organisation ships two connector scaffolders, and the stated direction is that this one
absorbs the other. That is a destination with conditions attached, **not a deprecation
announcement**: both tools ship today, and nothing here schedules the other's retirement.

This page is the conditions. [ROADMAP § Stage G](./ROADMAP.md#stage-g--consolidation--) points
here, and this page is the whole of what that stage means. It is a separate document rather
than a roadmap section because most of it is not a backlog: of the four preconditions below,
one is an emitter change this repository could make, one is a thing this repository has decided
**not** to do, one belongs to the SDK repository, and one is owned by neither. Only the first is
a checkbox, and a stage of four `[ ]` bullets would have said otherwise.

## How to read the cross-repo claims on this page

Almost everything below is a statement about **another repository's internals**, which nothing
in this repository can gate on. So each is recorded with the commit it was read at and the date
it was read, in the manner of
[ROADMAP § The measured ceiling](./ROADMAP.md#the-measured-ceiling). A cross-repo fact stated
timelessly is a claim that will eventually be wrong and that no reader can falsify.

| Repository | Read at | On |
| --- | --- | --- |
| [Nimbus](https://github.com/nimbus-agent/Nimbus) — AGPL-3.0-only | commit `0a32751f`, `packages/mcp-connectors` tree `94fd3623` | 2026-08-07 |
| [nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk) — MIT, `main` | commit `84f9c383` | 2026-08-07 |
| nimbus-sdk, the unmerged RFC-0010 branch `docs/rfc-0010-diagnostics-spec` | commit `a485a47` | 2026-08-07 |

Both checkouts were read locally and **not re-fetched** that day, so upstream may have moved
past the commits named. **Every count of corpus connectors or manifests below is against that
`packages/mcp-connectors` tree**, `94fd3623` — the same tree
[The measured ceiling](./ROADMAP.md#the-measured-ceiling) was measured against, so the two pages
can be read together. Claims about *this* repository carry no date: they are checkable at HEAD,
which is where they must stay true. Nothing was copied out of the Nimbus checkout — reading it
to establish a fact is expected, transcribing it is not, and
[LICENSING.md](./LICENSING.md) is why.

## The two tools

| | [`@nimbus-dev/create-connector`](https://github.com/nimbus-agent/nimbus-sdk/tree/main/tools/create-connector) | `create-nimbus-connector` (here) |
| --- | --- | --- |
| Approach | fixed templates | JSON spec → emitted source |
| Languages | TypeScript, Python | TypeScript |
| Output shape | the contract-version handshake, then MCP over stdio | MCP over stdio, the existing corpus shape |
| Starting point | greenfield project | a described connector |
| Runtime | Node (`engines.node >= 22`) | Bun |
| Verified by | CI generates, installs, builds and runs it | byte-diff against the real connectors |

Two tools with near-identical names is a choice users should not have to make, which is the
whole motivation. Until the preconditions below are met, both ship and the READMEs cross-link
so an author can tell which one they want.

## The four preconditions

### 1. The handshake — smaller than this repository used to say

**What it is.** The template tool's connector performs a contract-version handshake on stdio
before it serves MCP. This generator's output starts serving immediately.

**What was wrong here.** `docs/ROADMAP.md` and `README.md` both attributed that handshake to
`NimbusExtensionServer` and concluded that supporting it meant a second target on the
`GenerateTarget` seam. Neither half holds.

- `NimbusExtensionServer` (`sdks/typescript/src/server.ts`) is not what the template is built
  on, and it could not be: its `registerTool` ignores both of its arguments and registers
  nothing, and its `start()` does nothing but throw when `manifest.id` is empty. Its one
  substantive method is a thin delegate to the same free handshake function the template calls
  directly.
- The template's entry module (`tools/create-connector/templates/typescript/main.ts`) never
  imports `NimbusExtensionServer`. It imports the handshake from `@nimbus-dev/sdk/ipc`, the
  registrar primitives from `@nimbus-dev/sdk/connector-kit` — the same entry point this
  generator's `--standalone` output already imports — and then serves MCP through the same
  `McpServer` and `StdioServerTransport` classes this generator already emits.

So the two tools do not produce structurally different products. They produce the same product
with a prologue in front of one of them, and the prologue is a spec field plus an emitter path,
not a third `GenerateTarget` (`src/emit/index.ts` declares that type as
`"monorepo" | "standalone"`, and nothing here needs a third member).

**What it would actually cost.** More than one function, and the scope is worth stating
precisely rather than rounding to "small":

- The connect site is **not** a single function. `tail()` (`src/emit/server/index.ts`) writes
  the transport construction and connect for `hand-rolled` and `rest-kit` at both targets — four
  of the six emitted shapes. It returns `undefined` for `read-only-kit`. At the standalone
  target that style's connect is written a few functions away, by `renderRunReadOnlyGlue()`. At
  the **monorepo** target it is not written by this repository at all: the emitted server
  imports `runReadOnlyMcpConnector` from `../../shared/`, and that module constructs and
  connects the transport itself. So five of the six shapes are reachable from here, and the
  sixth — `read-only-kit` × `monorepo` — is reachable only through a change in Nimbus. That
  sixth is not a corner case: it is the style
  [Stage D](./ROADMAP.md#stage-d--the-read-only-kit-style-and-search-tools-x) was built for.
- The transport cannot stay zero-argument. A handshake consumes bytes off stdin, and the peer's
  hello and its first request commonly arrive in one read, so the template hands its transport
  an explicit input stream that replays what the handshake reader already buffered. The emitted
  server would gain that stream and the imports behind it.
- Those imports are new module-scope names, so [CLAUDE.md](../CLAUDE.md)'s rule applies: they
  join `RESERVED_IDENTIFIERS` (`src/validate.ts`) **in the same change**, not afterwards.

**Why it is byte-safe by construction.** The manifest field that would gate it,
`contractVersions`, is the SDK's own — its `ExtensionManifest` carries it and its v1 conformance
corpus has a valid case for it — and **zero of the 94 corpus manifests declare it**; the
identifier appears nowhere under Nimbus's `packages/` at all. A path gated on a field the corpus
never sets cannot move `newrelic`, `datadog`, `grafana` or `sentry`, which is the bar
[Pillar 1](./ROADMAP.md#1-fidelity--the-output-is-indistinguishable-from-hand-written) sets for
every new emitter path.

### 2. Python — unschedulable here, and not because of effort

This is the one precondition that is not waiting on a decision. It is stated so that nobody
schedules it, because every quality mechanism this project has is unavailable for Python output:

- **There is no Python connector-kit to emit against.** The SDK's TypeScript package exports a
  `./connector-kit` subpath; its Python distribution publishes no equivalent. The Python
  template says so in its own module docstring, and inlines the handful of lines such a kit
  would absorb — deliberately, on the stated grounds that a scaffold is not where a new
  published surface gets designed.
- **`formatAll()` runs Biome**, which has no Python formatter. Output that is not run through
  the same formatter the corpus is formatted with cannot be held to this project's bar, because
  that bar is byte equality.
- **Decisively, there is no Python corpus.** All 94 corpus manifests declare `"runtime": "bun"`,
  and `packages/mcp-connectors/` contains no Python source at all. `diff:golden`, `reach` and the
  four-fixture byte invariant have nothing to diff against — so Python output would be verified
  by generating it and reading it, which is exactly the standard
  [CLAUDE.md](../CLAUDE.md) refuses.

Against a fixed template that a tree copy already reproduces exactly, that is a large amount of
machinery to give up for no gain. Emitting Python is therefore not a roadmap item awaiting
capacity; it is a thing this generator would do worse than the tool that already does it.

### 3. `npm create` — release infrastructure, not a generator feature

`npm create @nimbus-dev/connector` resolves to `@nimbus-dev/create-connector`, which is
published (`latest` 0.1.0 on the npm registry, checked 2026-08-07). Retiring an invocation that
is already on people's command lines is a publishing problem, and it sits outside this
repository twice over:

- **The name cannot simply move here.** The SDK's own design documents record choosing the
  scoped name *over* the unscoped `create-nimbus-connector` — the name this repository holds —
  because npm's unscoped namespace is flat and the project had already lost `nimbus-sdk` on
  PyPI to an unrelated package. A name inside a scope you own cannot be taken from you. That
  reasoning was not about this repository, and it does not become wrong because this repository
  exists.
- **`npm create` is a Node entry point, and this project is Bun-only.** The SDK's scaffolder
  declares `engines.node >= 22` and ships a built `dist/`. This repository's `bin` points at
  `src/cli.ts`, which carries a `#!/usr/bin/env bun` shebang, so Bun is still required however
  the command is spelled — the invocation does not adapt the runtime, it only changes who types
  what. The single Node path this project has is `npm publish --provenance` in CI, and
  [ROADMAP § Non-goals](./ROADMAP.md#non-goals) keeps it that way.

So the condition is not "build a feature". It is: own the entry point, or provide a migration
that does not silently change what people get when they run a command they already run.

### 4. The `permissions` shape fork — owned by neither repository

The two repositories currently disagree about the type of a required manifest member.

- **nimbus-sdk `main` treats it as an array.** Every valid case in the v1 manifest conformance
  corpus writes `permissions` as an array of strings, and the SDK's contract-test validator
  enforces that with an array type rule plus a per-entry rule — so it is the validator's shape,
  not merely the fixtures'.
- **Nimbus treats it as an object.** All 94 corpus manifests write `"permissions": {`, and the
  gateway reads named members off it (`permissions.network`, `permissions.filesystem.read`,
  `permissions.filesystem.write`).

This generator emits the object, because it reproduces the corpus.

**The fork has in-flight resolution, running in this generator's favour.** On the unmerged
RFC-0010 branch, the sandbox conformance case schema describes `permissions` as accepting any
JSON value, because the harness must tolerate *the legacy array form*, null, and an absent
object without failing. The array is the form being called legacy. The SDK is not sitting on a
rival contract; it is moving toward the shape this generator already emits.

**This generator will not add a translation layer.** Emitting two manifest shapes behind a flag
would mean emitting one that no consumer in the corpus accepts, and it would let this
repository paper over a contract fork between two others — making the fork permanent and
invisible rather than resolved. That is the false-green pattern at organisational scale, and
this repository removes those rather than adding them.

**What it actually blocks, and when.** Precondition 1 and nothing else. Python and `npm create`
are untouched by it. And it blocks that target only *if it is still unresolved when the target
ships* — which, given RFC-0010, it may well not be. RFC-0010 is the thing to watch; re-read it
before treating this as live.

## The free interim item

The cross-link is one-directional. This repository's [README](../README.md) points at
`@nimbus-dev/create-connector` and says when to prefer it; as of 2026-08-07 at nimbus-sdk
`84f9c383`, **no tracked file in that repository links here.** Five of its Markdown files
mention this package by name, all of them naming a roadmap box or recording why the scoped name
was chosen — none is a link. An author who arrives at the SDK first has no way to learn this
tool exists. That costs
nothing to fix and is not blocked by anything above — but the fix belongs in the other
repository, which is why it is recorded here rather than tracked as work.

## What consolidation does not mean

- **It is not a deprecation.** Nothing above schedules a removal, and until all four
  preconditions are met, both tools ship.
- **It is not absorbing the other tool's decisions.** The scoped-name reasoning, the Python
  template's inlined kit lines and the SDK's manifest contract are the SDK's to change. This
  page records them; it does not overrule them.
- **It does not change what a connector *does*.** See
  [ROADMAP § Non-goals](./ROADMAP.md#non-goals) — the manifest vocabulary and the tool-output
  envelope are Nimbus's to define either way.
