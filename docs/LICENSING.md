# Licensing

What `create-nimbus-connector --from-connector` may and may not produce. The three-repository
split that makes this a live question is [CLAUDE.md](../CLAUDE.md)'s; this document assumes it
rather than restates the table.

## Deriving a spec is not vendoring

`--from-connector <dir>` reads a connector directory — `src/server.ts` and
`nimbus.extension.json` — and prints the `ConnectorSpec` JSON that would regenerate it. It is
the authoring-aid framing of the same code `bun run reach` already runs over the whole corpus:
`src/derive/` is, as [CLAUDE.md](../CLAUDE.md)'s layout note puts it, "the inverse of
`src/emit/`", and `deriveFromDirectory` (`src/derive/from-connector.ts`) calls the identical
`deriveSpec` (`src/derive/index.ts`) that `scripts/reach.ts` calls once per corpus connector.
The two differ only in what they do with the answer: `reach` diffs it against a corpus baseline
and reports a tier; `--from-connector` prints it.

That difference is exactly why `reach` shipped first without this document having to exist. It
could rely on a structural guarantee that `reach` still has and `--from-connector` cannot:
**`reach` never writes a derived spec to disk** — `scripts/reach.ts`'s own header says so, and
`scripts/_lib/reach.ts` holds no write path at all — so there was no code path through which
corpus-derived content could reach this repository's tracked files. Printing *is* what
`--from-connector` is for: a user who cannot see the derived spec
cannot edit it or feed it back through `--spec`. So the "never touches disk" guarantee cannot be
the answer here, and the guardrail has to live somewhere else — see
[the one thing that stays forbidden](#the-one-thing-that-stays-forbidden), below.

None of that makes running `--from-connector` against a real Nimbus connector vendoring. Three
things are true of it, and none of them is true of copying source into this repository:

- **The output is a description, not the source.** A `ConnectorSpec` names tool paths, HTTP
  methods, env vars and a handful of formulaic locals — the shape `src/emit/` needs to
  regenerate the file, not the file itself. It is markedly smaller and strictly less expressive
  than what it was derived from; [ROADMAP.md's Known
  limitations](./ROADMAP.md#known-limitations) is the standing list of real-corpus shapes no
  spec can even describe.
- **It is produced on the user's own machine, from a checkout they already have.** Pointing
  `--from-connector` at a directory is a local file read and an in-process parse — nothing is
  transmitted anywhere. That is the same posture `diff:golden` and `wiring:conformance` already
  have reading a Nimbus checkout at `--nimbus-root`, just aimed at one connector instead of the
  whole corpus.
- **Nothing AGPL-derived enters *this* repository.** The spec exists in the user's terminal and,
  if they redirect it, their own filesystem — outside `create-nimbus-connector`'s tracked tree.
  What a user does with a spec derived from their own checkout, in their own project, is exactly
  as much this repository's concern as what they do with `diff:golden`'s output: none.

## The one thing that stays forbidden

**A spec derived from a real Nimbus connector may not be committed to `fixtures/` in this
repository.** [CLAUDE.md](../CLAUDE.md) requires every fixture to be hand-written, not
extracted — and a derived fixture would break that rule twice over, not once.

First, mechanically: `deriveSpec` reads `description` straight off `manifest.description`, and
every other field — tool `path`s, `method`s, env `vars`, `style` — by walking the real
`src/server.ts` AST. That is extraction, the exact thing `fixtures/*.spec.json` are defined not
to be. The [description-string carve-out](#the-description-string-carve-out) already permits the
description text specifically; it says nothing about the rest, because the rest is ordinary
connector structure recovered from AGPL source, not a string a byte-matching test needs verbatim.

Second, and worse for what this project actually depends on: **it would make `diff:golden`
compare the corpus against itself.** The harness's whole claim is that a spec an author wrote by
hand, describing a connector in the abstract, regenerates that connector byte-for-byte — evidence
that the *template* is faithful, independent of how the spec came to exist. A fixture derived
from the same connector it is diffed against removes that independence: `deriveSpec` and
`generate()` would only need to be inverses of each other — a property internal to this
repository — to pass. `test/derive/round-trip.test.ts` already runs exactly that round trip, in
memory, as a coverage measurement; running it again on disk, permanently, as an "acceptance
test" would launder a tautology as verification. `diff:golden`'s four protected 6/6 fixtures stay
meaningful only because none of the eleven real-connector fixtures were produced this way.

## What the user owns

A **standalone** connector generated from a derived spec is the user's own code, under whatever
`--license` they pass to `--standalone` — see the README's [Licensing of generated
connectors](../README.md#licensing-of-generated-connectors). Deriving the starting spec from a
connector they have permission to read does not change that: the generator's output license is a
function of the target and the flag, never of where the input spec came from.

A **monorepo**-target connector generated from a derived spec is `AGPL-3.0-only`
unconditionally, for the same reason any monorepo-target connector is — it lives inside the AGPL
Nimbus repository and imports AGPL code through `../../shared/*`, regardless of how its spec was
authored.

## The description-string carve-out

[CLAUDE.md](../CLAUDE.md) already states the carve-out and its bound: description strings only,
never connector code, `shared/` source or filter bodies. A spec `--from-connector` derives from a
real connector will contain that connector's exact description strings, because `deriveSpec`
reads them verbatim off the manifest — the same as the eleven hand-written fixtures do by hand.
That is consistent with the carve-out, not an extension of it: the strings are the one thing the
carve-out already allows to be reproduced exactly. What it does not allow — and what a derived
fixture would add on top — is everything else in the file being extracted too.
