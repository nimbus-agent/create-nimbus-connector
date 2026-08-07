# Using create-nimbus-connector

A start-to-finish guide to generating a Nimbus MCP connector. To look a spec field up, see
[SPEC.md](./SPEC.md); for the rules that reject a spec, and how the fields work together, see
the [README](../README.md); for how the generator is built see
[ARCHITECTURE.md](./ARCHITECTURE.md).

**Bun is required.** The CLI carries a `#!/usr/bin/env bun` shebang, so it needs Bun however
you invoke it — `bunx` included. Generated connectors are Bun-only too.

---

## 1. Pick your target first

This is the one decision that changes everything downstream, so make it before you start.

**Standalone** — a self-contained package that runs anywhere. It resolves its helpers from the
published `@nimbus-dev/sdk`, needs no Nimbus checkout, and gains `dev` and `build` scripts.
This is what you want for a third-party connector, and what you want if you are unsure.

```bash
bunx create-nimbus-connector my-service --standalone
```

**Monorepo-internal** — a package that lives at `packages/mcp-connectors/<name>/` inside a
Nimbus checkout and imports `../../shared/*` by relative path. Those imports resolve only
inside the monorepo. This is the default, for historical reasons: the generator was built to
speed up first-party connectors.

```bash
bunx create-nimbus-connector my-service
```

---

## 2. Two ways to drive it

### Interactive

Run it with a name and answer the prompts — connector name, display name, service label,
description, base API URL, auth type, credential env var, and the read tools to register:

```bash
bunx create-nimbus-connector my-service --standalone
```

Good for a first connector or a simple one. Every prompt has a default; pressing Enter through
all of them produces a working single-tool connector.

### From a spec file

Everything the prompts collect, plus everything they do not, lives in a JSON spec:

```bash
bunx create-nimbus-connector --spec ./my-service.spec.json --standalone
```

`--spec` and a positional name are mutually exclusive — the name comes from the file. **Use a
spec file for anything real.** It is reviewable, diffable, and the only way to reach write
tools, OAuth, search tools and the manifest fields.

---

## 3. Writing a spec

Start minimal. This is a complete, valid spec:

```json
{
  "name": "acme",
  "displayName": "Acme",
  "description": "Acme connector. Surfaces widgets as `acme:widget` items.",
  "serviceLabel": "Acme",
  "style": "hand-rolled",
  "network": ["api.acme.com"],
  "env": [
    { "vars": ["ACME_TOKEN"], "local": "authHeader", "bindings": ["t"], "auth": "bearer" }
  ],
  "fetchHelper": {
    "local": "acmeGet",
    "base": "https://api.acme.com",
    "headers": "authHeader"
  },
  "tools": [
    { "name": "acme_widget_list", "description": "List widgets.", "path": "/v1/widgets" },
    {
      "name": "acme_widget_get",
      "description": "Fetch one widget by id.",
      "args": { "id": { "type": "string", "min": 1 } },
      "path": "/v1/widgets/${arg.id|enc}"
    }
  ]
}
```

Then grow it. The pieces you are most likely to reach for next:

| Want | Add |
| --- | --- |
| A write tool | `"method": "POST"`, `"effect": "write"`, optionally `"body"` |
| Substring search | `"impl": "search"` with `rows`, `maxLimit`, `filter` |
| OAuth | an env entry with `"auth": "client-credentials"`, `tokenUrl`, `credentialsIn` |
| A tool you cannot express | `"impl": "stub"` — a typed handler that throws, never a silent guess |

The README documents each of these in full, with the corpus measurements behind the defaults.
`fixtures/*.spec.json` are working examples — `fixtures/sentry.spec.json` for a plain read
connector, `fixtures/mercury.spec.json` for search, `fixtures/zzwrite.spec.json` for writes.

**Three rules that will save you time:**

1. **Unexpressible fields are hard errors, not downgrades.** If the spec says something the
   emitter cannot render, generation fails with a message naming the field. It will never
   silently emit something other than what you described.
2. **You cannot reuse the emitter's own identifier names.** `token`, `root`, `matchesResult`
   and others are reserved because the generated file declares them. The error names the
   collision; rename your `local`.
3. **`style` matters more than it looks.** `rest-kit` cannot do OAuth or search;
   `read-only-kit` and `hand-rolled` can. Pick `hand-rolled` if you are unsure.

---

## 4. Look before you write

`--dry-run` prints the file tree with byte sizes and writes nothing:

```bash
bunx create-nimbus-connector --spec ./acme.spec.json --standalone --dry-run
```

**Use it, because connector output overwrites without asking.** `writeFiles` creates parent
directories and writes each file; there is no existence check and no prompt. Generating into a
directory that already holds a connector will replace those files in place. (The two Gateway
wiring files are the exception — those refuse to overwrite unless you pass `--force`.)

---

## 5. What you get

Six files, plus a seventh when the spec declares a search tool:

```
src/server.ts            env accessor → fetch helper → tool registrations → stdio connect
src/search-filter.ts     only when a search tool is declared
test/sandbox.test.ts     the corpus-standard sandbox test
package.json
nimbus.extension.json    id, displayName, permissions, hitlRequired, syncInterval
tsconfig.json
README.md                carries the public-tier H2 the monorepo audit requires
biome.json               standalone only
```

---

## 6. Verify it

For a standalone package, run its own scripts — they are real, not decorative:

```bash
cd acme
bun install
bun run typecheck    # tsc --noEmit
bun run lint         # biome check src/
bun run build        # bun build src/server.ts --outdir dist --target bun
bun run dev          # serves MCP over stdio
```

**Do not treat `bun test` in a generated package as verification.** The generated
`test/sandbox.test.ts` is wrapped in `describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])`,
and that variable is set nowhere in Nimbus — the test skips. It exists to match the corpus
shape. The real bar is `typecheck` + `lint` + the server actually answering `tools/list`.

To confirm it serves MCP, run it and send a `tools/list` request over stdio; the connector
reads credentials from the environment only, so export your `env.vars` first.

---

## 7. First-party connectors: the Gateway wiring

A connector living inside the monorepo also needs type-coupled registration in the Gateway,
which this tool does **not** generate — sync handlers live in
`packages/gateway/src/connectors/` and no connector package contains one.

`--gateway-wiring <nimbus-root>` emits a wiring skeleton and prints a verified checklist of the
sites to touch (catalog, connector-secrets-manifest, rate-limiter):

```bash
bun src/cli.ts --spec ./acme.spec.json --gateway-wiring /path/to/Nimbus
```

It refuses to overwrite existing wiring files unless you pass `--force`. `--gateway-wiring` is
incompatible with `--standalone`, since a standalone connector has no Gateway to wire into.

---

## 8. Deriving a spec from an existing connector

`--from-connector <dir>` runs the pipeline in reverse: point it at a directory holding
`src/server.ts` and `nimbus.extension.json` — a connector this tool generated, or one you
already maintain — and it prints the `ConnectorSpec` JSON that would regenerate it, instead of
writing anything.

```bash
bunx create-nimbus-connector my-service --standalone
bunx create-nimbus-connector --from-connector my-service > my-service.spec.json
```

This is an authoring aid, not a second output format: the printed JSON goes back through
`--spec` to regenerate the package, and is meant to be read, edited and diffed like any
other spec in this repo's `fixtures/`. **One field is recovered but not guaranteed**, and it is
worth knowing before you trust a derived spec unread: for `style: "rest-kit"`, `title` is
recovered by inverting the registrar name, and that sanitization is many-to-one — a title with a
space regenerates the same `src/server.ts` and a different `README.md`. Check `title` by eye;
[ROADMAP.md's Known limitations](./ROADMAP.md#known-limitations) has the entry.
[`docs/LICENSING.md`](./LICENSING.md) is the full answer
on what that is and is not — the short version is that running this against a checkout you
already have is not vendoring, but a spec derived from a **real Nimbus connector** may never be
committed to this project's own `fixtures/`.

**Two outcomes, not one.** A connector this generator's spec language cannot fully describe is
`blocked`, not silently approximated: the CLI prints which constructs stopped the read, in the
same vocabulary `bun run reach --verbose` uses, and exits non-zero. This includes a spec that
reads back cleanly but then trips `RESERVED_IDENTIFIERS` (`src/validate.ts`) — e.g. a
hand-authored connector whose fetch helper happens to be named `token` or `url` — reported as a
`rejected-by-validate` blocker rather than printed as if it were a success: every spec that
reaches stdout on exit 0 has already passed `parseSpec` and `validateSpec`, which is what makes
the round-trip claim below true rather than aspirational. Add `--partial` to get a draft instead
of only the report — the draft carries a `$partial` marker key that `ConnectorSpecSchema` refuses
by construction, so it cannot be generated until you resolve every blocker and delete the key by
hand. Either way, watch stderr: an `effect` (`read`/`write`/`delete`) that could not be pinned to
one tool is printed as a note asking you to confirm it, because the manifest's `hitlRequired` set
alone does not always say which tool earned it.

`--from-connector` is mutually exclusive with a positional name, `--spec`, `--gateway-wiring`,
`--out-dir`, `--standalone`, `--license` and `--dry-run` — it takes the connector's name and
target from the directory it reads (the target is printed as a stderr note, not asked for), and
it only ever prints to stdout, so none of the flags that shape a write have anything to act on.

---

## 9. Flag reference

| Flag | Effect |
| --- | --- |
| `--standalone` | Self-contained package; defaults output to `<name>/` |
| `--spec <path>` | Load a `ConnectorSpec` JSON file instead of prompting. Excludes a positional name |
| `--dry-run` | Print the file tree, write nothing |
| `--out-dir <path>` | Write somewhere other than the default |
| `--license <spdx>` | SPDX identifier for the generated `package.json`. **`--standalone` only** — a monorepo-target connector is AGPL-3.0-only unconditionally, since it lives in the AGPL repo and imports AGPL code. Rejects npm's `SEE LICENSE IN <file>` form, which is not SPDX |
| `--gateway-wiring <root>` | Also emit the Gateway wiring skeleton and checklist. Monorepo target only |
| `--force` | Allow overwriting existing **wiring** files. Only valid with `--gateway-wiring` |
| `--from-connector <dir>` | Read an existing connector directory and print its derived spec. Excludes a positional name, `--spec`, `--gateway-wiring`, `--out-dir`, `--standalone`, `--license` and `--dry-run` |
| `--partial` | With `--from-connector`, print a draft spec (marked so it cannot be generated) instead of only a blocker report. Only valid with `--from-connector` |
| `--help` | Usage |
| `--version` | Version |

An unrecognised flag is an error with a did-you-mean suggestion rather than being ignored.

---

## 10. Troubleshooting

**`command not found` / the shebang fails.** The CLI is Bun-only. Install Bun; `npx` will not
work.

**A validation error names a field I did not set.** Defaults are applied before refinements
run, so a rule can fire on a defaulted value — `maxLimit` is the usual one. The message names
the field that must change.

**`Identifier collision: "<name>"`.** A spec-supplied identifier matches either another one or
a name the emitter declares. `src/validate.ts`'s `RESERVED_IDENTIFIERS` is the authoritative
list.

**Standalone `bun install` cannot resolve `@nimbus-dev/sdk`.** The generated floor may name a
release that is not published yet. Check the version in the generated `package.json` against
what is on npm.

**`--from-connector` says `@babel/parser is not installed`.** It is an `optionalDependency`,
needed only to read an existing connector's source, not to generate one. Run
`bun add @babel/parser` and try again.

**`--from-connector` reports `cannot read <dir> into a spec`.** The directory uses a construct
the spec language does not model. Each line names the construct; [ROADMAP.md's Known
limitations](./ROADMAP.md#known-limitations) lists the ones that are permanent. Add `--partial`
for a draft to work from instead of only the report.

**The generated connector typechecks but a tool fails at runtime.** Credentials come from the
environment only. Confirm every `env.vars` name is exported; the accessor throws by design
when one is missing or empty.
