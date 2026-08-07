---
name: cnc-reach-deriver
description: >
  The corpus-reach harness and its spec deriver — `bun run reach`, the four
  tiers, the totality rule, guarded AST accessors, byte-range claims, the
  two-list frame contract, and the baseline keyed on `connectorsTree`. Use when
  writing or changing anything under `src/derive/` or `scripts/reach*`,
  adding a recognizer, reading a blocker histogram, or asking why a connector is
  `blocked` / why a fixture must appear in `test/derive/round-trip.test.ts`.
---

# The reach harness and its deriver

`bun run reach --nimbus-root <path>` answers one question: **how many of the 94 real connectors
can this generator derive a spec for and regenerate, and how far does each get.** It reads the
AGPL monorepo at runtime — never vendors it — so it cannot run in CI, and no job may skip when
the root is absent.

It is the inverse of the rest of the repo: `src/emit/` turns a spec into source, and
`src/derive/` turns source back into a spec. The round trip is the proof.

## Layout

```
scripts/reach.ts               the CLI: measure, histogram, --baseline comparison
scripts/reach-baseline.ts      records fixtures/reach-baseline.json (full corpus, always)
scripts/_lib/reach.ts          measure(), tiering, histogram, summary lines
scripts/_lib/reach-baseline.ts assertComparable, compareBaseline, connectorsTreeRefusal
src/derive/
  ast.ts        the Babel boundary — parseModule, the AstNode type
  read.ts       THE ONLY module that reads a node's fields
  claims.ts     byte-range claims and containment coverage
  blockers.ts   an unclaimed statement -> a histogram bucket
  manifest.ts   nimbus.extension.json -> spec fields
  search-filter.ts  src/search-filter.ts -> filter entries, its own totality rule
  index.ts      deriveSpec(files) -> Derivation
  from-connector.ts  a connector DIRECTORY -> a spec, or named blockers (--from-connector)
  server/       one recognizer module per src/emit/server/ module:
                args, body, env, fetch-helper, frame, hoists, index,
                path-template, query, search, tools-hand, tools-rest
test/derive/*.test.ts          a test file per deriver module, plus the round trip
```

**A recognizer may import `src/spec.ts`; it may never import `src/emit/`.** `server/body.ts`
takes `parsePathTemplate` from `src/spec.ts` so its reconstruction of `renderBodyExpr`'s default
body uses the same path parser the emitter does — a private copy that under-parses leaves an arg
in the default set and produces a spurious explicit `body` that is byte-identical and invisible
to every gate, while one that over-parses throws. Sharing removes the only direction nothing can
see. That argument covers the spec language's **parsers** and nothing else: importing the
emitter's **renderer** would let a renderer bug agree with itself, which is the opposite trade.

**The deriver lives under `src/derive/`, and ships.** `package.json`'s `files` is
`["src", "README.md"]`, so it reaches npm — which is the point: `--from-connector` is the same
code pointed at a user's directory rather than at the corpus. `@babel/parser` is an
`optionalDependency`, following `@biomejs/js-api`, and `src/derive/ast.ts` imports it dynamically
so a consumer without it loses `--from-connector` and nothing else.

It lived under `scripts/` until the flag existed, because shipping unreachable code and an
unresolvable import in every tarball would have been the wrong trade. That reasoning expired when
the code stopped being unreachable.

## The four tiers

| Tier | Means |
| --- | --- |
| `blocked` | the deriver could not produce a spec at all |
| `emits` | `parseSpec` **and** `validateSpec` accept the derived spec |
| `server-identical` | the emitted `src/server.ts` byte-matches the real one — **the headline** |
| `all-identical` | every emitted file byte-matches |

`server.ts` is the headline because every emitter risk lives in that file.

## The invariants

### The totality rule, and no escape hatch

After every matcher runs, every top-level and function-body statement in `src/server.ts` must be
covered by a claim. **An unclaimed statement fails the connector.** There is no
ignore-the-rest path and there will not be one.

This is the whole difference between this harness and the hand counts that produced 12, then 7,
then 9: a scrape is silent about what it does not recognize, and silence reads as absence. The
number this prints is deliberately *lower* than a scrape would report. A connector using a
construct the spec language declines to support **is** blocked — `zoom` permanently so — and
that is the measurement, not a shortcoming of it.

**Blockers are discovered, not enumerated.** An unclaimed statement's `kind` is a normalized
descriptor of its syntactic head (`import-from:./tools.ts`, `call:makeQueryFilter`,
`frame:no-registrar`), and the histogram is a group-by over those strings. Never add a category
list; a shape nobody has named appears as its own bucket.

### `AstNode` has no index signature — that is the enforcement

`ast.ts`'s `AstNode` carries only `type`, `start`, `end` and `loc`. **Every other field read goes
through a guarded accessor in `read.ts`**, and `bunx tsc --noEmit` is what enforces it: with an
index signature, `node["computed"]` typechecks for any key and yields `undefined`, and whether
that `undefined` rejects or matches depends on which side of a comparison it lands on. Eight
defects across five files were instances of that one shape — a matcher that validates part of a
construct and claims the whole of it.

The totality rule cannot catch that class. It detects statements nobody claimed; it is blind to
statements claimed **wrongly**. So the guard sits where the value is obtained.

- **Reaching a node field with no accessor means adding an accessor to `read.ts`**, never
  casting at the call site.
- Accessors return `undefined` rather than throwing, so rejecting stays the cheap default.
- There is deliberately **no generic `getChildren`**: an untyped child list strips which *slot*
  a node came from, and the slot is what the guards depend on.
- One confined exception exists on purpose: `server/fetch-helper.ts`'s internal `walk`/`find`
  recurse over `Object.entries()` to locate a `fetch()` call anywhere in a body. Neither is
  exported. `tsc` cannot enforce that confinement, so it holds by review.

### Claims are byte ranges; coverage is containment

Both are required, not incidental. A matcher may claim **several statements at once**, because
the emitter writes multi-statement constructs — hoisted argument consts, the query branch's
`new URL` trio, the client-credentials `token`/`cachedToken`/`tokenExpiresAt` bindings. And a
statement is covered when its range lies *inside* a claimed range, so nested statements need no
separate claim.

Containment is also the hazard the frame contract below exists to contain.

### The two-list frame contract

`Frame` hands downstream **two** statement lists, and they are not interchangeable:

- `toolStatements` — what the tool recognizers scan.
- `verifyStatements` — what the totality rule walks.

They differ for `read-only-kit` only. That style nests its registrations inside a container, so
*claiming* that container would cover every registration transitively: the totality rule would
find nothing unclaimed and a connector whose tools were never recognized would derive
successfully — a false `emits` produced by the very mechanism the rule exists to remove.

`recognizeReadOnlyFrame` reads **two entry shapes**, and the rule is the same for both:

- the inline wrapper, `await runReadOnlyMcpConnector("nimbus-x", (reg) => { ... })` — what this
  generator emits;
- the **named registrar**, an exported `register<X>Tools(reg: ZodToolRegistrar)` declaration
  passed by bare reference from an exported `startConnector()` — what ten corpus connectors
  write, and a case-2 shape the emitter never produces.

Either way the branch removes **exactly one** statement — the container — from
`verifyStatements`, splices its body in, and **never claims the container**. It is still fully
verified (for the wrapper: the await, the callee, arity 2, the `"nimbus-<name>"` literal, a
single-parameter `(reg) =>` block arrow, not async; for the named form the equivalent pins in
`namedReadOnlyStarter` / `namedRegistrarBody`); it is simply never granted coverage.

**If you add a frame style that nests registrations, it inherits this rule.**

### One recognizer module per emitter module

`src/derive/server/*` mirrors `src/emit/server/*`. A recognizer reads what its
counterpart writes, and the round-trip test is what keeps the pair honest — including the
places where the two must agree on a literal the other side chose (`tools-rest.ts` mirrors the
emitter's parameter name `parsed`, `tools-hand.ts` mirrors `p`). The mirror is not one-to-one in
both directions: `frame.ts` and `hoists.ts` model constructs no single emitter module owns, so
they have no counterpart.

Match only what the emitter can actually produce. Widening a matcher to accept a shape the
emitter never writes only widens what gets claimed — see the deliberate leading slash in
`RUN_READ_ONLY_SUFFIX`, and `isFrameImport` deliberately *not* matching it.

### The baseline is keyed on `connectorsTree`, not on HEAD

`fixtures/reach-baseline.json`'s first key is the git tree object of `packages/mcp-connectors` —
the only path the harness reads. Keying on a commit SHA was tried and refused: two commits can
carry a byte-identical `packages/mcp-connectors`, and refusing on a SHA that moved while the
tree did not made `--baseline` refuse a corpus that had not actually changed.

`bun run reach --baseline` exits 2 rather than comparing when the checkout is dirty under
`packages/mcp-connectors`, when the recorded tree differs, or when `--baseline` is combined with
connector names. Each refusal is the gate working. **Never edit the baseline to make a
regression pass** — re-record with `bun run reach:baseline`, and only when the corpus moved.

### `deriveSpec` returns a raw object, not a `ConnectorSpec`

`Derivation` is
`{ ok: true; spec: Record<string, unknown>; $effectAmbiguity?: string[] } | { ok: false; blockers: Blocker[] }`.
Validation is a **tier boundary the reporting layer crosses**, not something the deriver does —
which is also what lets a derived spec that trips `RESERVED_IDENTIFIERS` be *counted* rather than
thrown. Returning a `ConnectorSpec` would put `parseSpec` inside the deriver and turn that
counted near-miss into an exception, which is the measurement the histogram exists to take.

### Every fixture appears in exactly one of `ROUND_TRIP` / `PARTIAL_ROUND_TRIP` / `BLOCKED`

`test/derive/round-trip.test.ts` holds all three lists, and its
`accounts for every fixture in fixtures/` test fails when a fixture is in none or in more than one.
`BLOCKED` records the construct that stops each one, and `PARTIAL_ROUND_TRIP` the FILES a fixture
that does derive still fails to reproduce (and why), so the gap is on screen on every run rather
than implied by absence — the same reason `expectations.json` omits a file instead of hiding it.
A `PARTIAL_ROUND_TRIP` file is asserted to actually differ, so an entry that closes fails loudly
instead of silently weakening the check.

**Adding a fixture means adding it to one of those lists.** A `BLOCKED` reason must be
checked by actually running `deriveSpec` against the fixture's emitted output, never inferred
from the spec or the emitter: two earlier versions of that docstring went stale exactly that way.

## The recognizer set is complete; the ceiling is not a recognizer problem

**`BLOCKED` is empty.** Every fixture in `fixtures/` derives, and every one re-emits
byte-identically except `google-meet`, which sits in `PARTIAL_ROUND_TRIP` on one file
(`README.md`) because a rest-kit `title` is recoverable from `src/server.ts` only up to
`registrarName`'s sanitization. Every `src/emit/server/` module now has its counterpart under
`src/derive/server/`, including `body.ts`, and `recognizeQueryBlock` reads **both** query
branches — the rest-kit one and the hand-rolled one.

**So a new recognizer is no longer the obvious next move.** `docs/ROADMAP.md`'s
[*The measured ceiling*](../../docs/ROADMAP.md#the-measured-ceiling) groups every blocked corpus
connector by cause and splits each into a *spec-language gap* (a construct the spec cannot
express — no recognizer closes it) or a *recognizer gap*. Read that split before writing a
matcher: the largest remaining shapes are spec-language gaps, and three of them do not appear in
the histogram at all, because the connectors carrying them are blocked earlier. A recognizer that
reads a shape the emitter does not write moves a connector to `emits` and never to
`server-identical` — legitimate, but say so up front.

**The design documents behind this work have been retired**, and their durable half is on the
pages that stay: the case-1 / case-2 rule that governs when a recognizer may read a shape the
emitter does not write is
[`docs/GLOSSARY.md` § Reach and derivation](../../docs/GLOSSARY.md#reach-and-derivation); the
per-construct ceiling is *The measured ceiling* above; the two-list frame contract is
`src/derive/server/frame.ts`'s own header; the guarded-accessor type rule is `src/derive/read.ts`'s.
Git history has the originals. Do not go looking for a backlog in them — where a retired plan and
the code disagree, the code is authoritative, and several of those documents' predictions were
measured wrong on the way (see the ceiling's own note on reading what the code does rather than
trusting a prediction).

## Before you claim a deriver change works

```bash
bun test test/derive/                                     # per-module + round trip
bunx tsc --noEmit                                        # the read.ts guard is a TYPE rule
bun run reach --baseline --nimbus-root C:/gitrep/Nimbus  # tier regression, needs the monorepo
```

`bun run reach --verbose` prints the connectors behind each histogram bucket, which is how a
near-miss gets identified rather than guessed at. A tier that *improved* is a result to state,
not to quietly re-baseline. See the `cnc-preflight` skill for the rest of the gate order.
