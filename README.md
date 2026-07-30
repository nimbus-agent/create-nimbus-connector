# create-nimbus-connector

A generator for [**Nimbus**](https://github.com/nimbus-agent/Nimbus) MCP connector packages. Nimbus's `packages/mcp-connectors/` holds 94+ connectors built from one rigid shape — a `server.ts`, a `nimbus.extension.json` manifest, a `tsconfig.json`, a `package.json`, a boilerplate `README.md`, and a constant `test/sandbox.test.ts`. Adding the next one means hand-copying those six files and editing the parts that vary. This tool turns that shape into a generator: describe a connector as a small JSON spec, and it emits all six files, run through the same Biome formatter the real connectors are formatted with.

Full design rationale, the two emission styles, and the acceptance criteria this project is held to live in [`docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md`](./docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md).

## Stage A boundary

This is **Stage A** — deliberately narrow:

- **One GET per tool.** Every tool is a single HTTP GET against a path built from a small template DSL (`${env.X}`, `${arg.X}`, `${arg.X|enc}`, `${arg.X|num}`, `${arg.X|bool}`). No request bodies, no non-GET methods, no pagination, no multi-step or multi-fetch tools.
- **Read tools only.** No write tools, no HITL-gated actions, no `hitlRequired` population.
- **Monorepo-internal.** Generated connectors are meant to live at `packages/mcp-connectors/<name>/` inside the Nimbus monorepo, where the `../../shared/*` relative imports (`mcp-tool-kit.ts`, `rest-tool-kit.ts`, etc.) resolve as-is. There is no standalone/`bunx`-distributable output yet — that is Stage B.

A tool spec that can't be expressed under these constraints sets `"impl": "stub"` and gets a typed handler that throws `"<tool> not implemented"` rather than being silently dropped or guessed at. Non-GET methods and other out-of-scope fields are a **hard validation error**, not an automatic downgrade to a stub — see the design doc's "Strict schemas" section.

## Usage

```
bun src/cli.ts <name>
```

Runs an interactive prompt session (name, title, description, network hosts, env vars, tools, ...) and writes the generated files to `packages/mcp-connectors/<name>/` (relative to the current directory).

The package is not yet published, so `bunx create-nimbus-connector <name>` does not work — that
form is what Stage B (standalone distribution) will enable. Run from a checkout of this repo
with `bun src/cli.ts` in the meantime.

### Flags

- `--spec <path>` — skip the interactive prompts and load a `ConnectorSpec` JSON file instead (see `fixtures/*.spec.json` for examples, e.g. `fixtures/sentry.spec.json`). Mutually exclusive with a positional `<name>` — the name comes from the spec file.
- `--dry-run` — don't write anything; print the file tree that would be created (path + byte size per file).
- `--out-dir <path>` — write to a directory other than the default `packages/mcp-connectors/<name>/`.

Examples:

```
bun src/cli.ts --spec fixtures/sentry.spec.json --dry-run
bun src/cli.ts --spec fixtures/sentry.spec.json --out-dir /tmp/sentry-preview
```

## The golden-fixture diff harness

`fixtures/*.spec.json` are hand-written specs modelled on real connectors already in the Nimbus monorepo. The harness regenerates each one in memory and byte-diffs it against the real file on disk, so the acceptance bar for the generator is "reproduces a real connector exactly," not "produces something that looks plausible."

```
bun run diff:golden                                    # all fixtures, resolves Nimbus by sibling-dir/env probing
bun run diff:golden sentry --nimbus-root C:\gitrep\Nimbus
bun run diff:golden sentry datadog --nimbus-root D:\Nimbus
```

`--nimbus-root <path>` points at a Nimbus checkout explicitly. Resolution order if omitted: `--nimbus-root` flag, then `$NIMBUS_ROOT`, then a sibling directory of this repo named `Nimbus` or `nimbus`. A resolved path must contain the marker file `packages/mcp-connectors/shared/mcp-tool-kit.ts`, or resolution fails loudly rather than producing a wall of missing-file errors.

Each fixture's expected identical-file count (out of 6) is checked in at `fixtures/expectations.json`. The harness fails if reality diverges from that count **in either direction** — a regression, or an unannounced improvement that would leave the expectations file and the design doc's gap report stale.

## The acceptance harness

`bun run acceptance <nimbus-root>` proves a generated connector doesn't just diff cleanly against a real one, but actually compiles and lints **inside** a live Nimbus checkout: it generates a throwaway `zzscratch` connector into `packages/mcp-connectors/zzscratch/`, runs `tsc --noEmit`, `biome check`, and `bun run audit:package-readmes` against it, then deletes it — via `try/finally`, so the scratch connector is removed even if generation or a check throws. It finishes by asserting `git status --short packages/mcp-connectors/` is empty in the target checkout, so a bug can never leave someone else's working tree dirty.

```
bun run acceptance C:\gitrep\Nimbus
```

## Development

```
bun test                              # unit tests for the emitters, independent of any monorepo checkout
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
```

`generate(spec)` (pure, no filesystem/env/clock access) and `formatAll(files)` (the only stage that touches Biome) are split deliberately so the emitters are unit-testable without a monorepo, and so the CLI, `--dry-run`, and the golden harness all format through the identical code path. See the design doc's "Generation is a pure function" section for the full rationale.

## License

[MIT](./LICENSE).
