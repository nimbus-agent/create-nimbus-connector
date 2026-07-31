# create-nimbus-connector

A generator for [**Nimbus**](https://github.com/nimbus-agent/Nimbus) MCP connector packages. Nimbus's `packages/mcp-connectors/` holds 94+ connectors built from one rigid shape — a `server.ts`, a `nimbus.extension.json` manifest, a `tsconfig.json`, a `package.json`, a boilerplate `README.md`, and a constant `test/sandbox.test.ts`. Adding the next one means hand-copying those six files and editing the parts that vary. This tool turns that shape into a generator: describe a connector as a small JSON spec, and it emits all six files, run through the same Biome formatter the real connectors are formatted with.

Full design rationale, the two emission styles, and the acceptance criteria this project is held to live in [`docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md`](./docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md) (Stage A — monorepo-internal generation) and [`docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-b-design.md`](./docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-b-design.md) (Stage B — standalone generation and publishing).

## Stage A boundary

This is **Stage A** — deliberately narrow:

- **One GET per tool.** Every tool is a single HTTP GET against a path built from a small template DSL (`${env.X}`, `${arg.X}`, `${arg.X|enc}`, `${arg.X|num}`, `${arg.X|bool}`). No request bodies, no non-GET methods, no pagination, no multi-step or multi-fetch tools.
- **Read tools only.** No write tools, no HITL-gated actions, no `hitlRequired` population.

A tool spec that can't be expressed under these constraints sets `"impl": "stub"` and gets a typed handler that throws `"<tool> not implemented"` rather than being silently dropped or guessed at. Non-GET methods and other out-of-scope fields are a **hard validation error**, not an automatic downgrade to a stub — see the design doc's "Strict schemas" section.

## Stage B: standalone connectors

By default, generated connectors are **monorepo-internal**: they live at `packages/mcp-connectors/<name>/` inside a Nimbus checkout, where the `../../shared/*` relative imports (`mcp-tool-kit.ts`, `rest-tool-kit.ts`, etc.) resolve as-is.

Pass `--standalone` to generate a connector that is self-contained instead — installable and runnable anywhere, with no Nimbus checkout required:

```
bun src/cli.ts <name> --standalone
```

The standalone `src/server.ts` imports its helpers from a single published entry point, `@nimbus-dev/sdk/connector-kit`, instead of `../../shared/*`. Its generated `package.json` depends on `"@nimbus-dev/sdk": "^1.11.0"` (see `src/emit/package-json.ts`), and it gains `dev` and `build` scripts (`bun build src/server.ts --outdir dist --target bun`) that monorepo-target output does not have.

**This CLI, and every connector it generates, is Bun-only** (design doc decisions B6 and B7): `nimbus.extension.json` declares `"runtime": "bun"` for every connector, `test/sandbox.test.ts` imports `bun:test`, and the standalone `build` script targets Bun. `src/cli.ts` carries a `#!/usr/bin/env bun` shebang. There is no Node, npm, or pnpm path anywhere in this project or its output.

**⚠ `@nimbus-dev/sdk` 1.11.0 does not exist on npm yet** — it ships the `./connector-kit` export a standalone connector's `package.json` depends on, and is a separate, not-yet-completed piece of work (Stage B, task 8). Consequently **this CLI is not published yet either**: publishing it now would let someone generate a standalone connector whose only dependency cannot be installed. Until 1.11.0 is released, run standalone generation from a checkout of this repo (`bun src/cli.ts <name> --standalone`), and verify it against a local, built SDK checkout with `bun run standalone-acceptance <sdk-root>` (see below) rather than a real `bun install`.

## Usage

```
bun src/cli.ts <name>
```

Runs an interactive prompt session (name, title, description, network hosts, env vars, tools, ...) and writes the generated files to `packages/mcp-connectors/<name>/` (relative to the current directory), or to `<name>/` when `--standalone` is passed.

The package is not yet published (see the SDK-dependency note above), so `bunx create-nimbus-connector <name>` does not work yet. Run from a checkout of this repo with `bun src/cli.ts` in the meantime.

### Flags

- `--spec <path>` — skip the interactive prompts and load a `ConnectorSpec` JSON file instead (see `fixtures/*.spec.json` for examples, e.g. `fixtures/sentry.spec.json`). Mutually exclusive with a positional `<name>` — the name comes from the spec file.
- `--standalone` — generate a self-contained connector (imports `@nimbus-dev/sdk/connector-kit`, gains `dev`/`build` scripts) instead of the default monorepo-internal shape. Defaults the output directory to `<name>/` instead of `packages/mcp-connectors/<name>/`.
- `--dry-run` — don't write anything; print the file tree that would be created (path + byte size per file).
- `--out-dir <path>` — write to a directory other than the default.
- `--license <spdx>` — **standalone only.** Set the generated package's license, in `package.json` and the README's License section. Defaults to `UNLICENSED`. Passing it without `--standalone` is an **error**, not a silent no-op: a monorepo-target connector is `AGPL-3.0-only` unconditionally.

### Licensing of generated connectors

A **monorepo** connector is `AGPL-3.0-only`. It lives inside the AGPL Nimbus repo and imports AGPL code through `../../shared/*`, and its `package.json` is byte-diffed against 94 real connectors — so this is fixed, not a default.

A **standalone** connector is none of those things: it is your own code, produced by an MIT-licensed tool, depending only on the MIT `@nimbus-dev/sdk`. Nothing about it obliges copyleft, so it is **not** stamped AGPL. It defaults to `UNLICENSED` — npm's marker for "no license granted" — which is a deliberate non-choice rather than a wrong choice made on your behalf. Pass `--license <spdx>` to set a real one:

```
bun src/cli.ts acme --standalone --license MIT
bun src/cli.ts acme --standalone --license "Apache-2.0"
bun src/cli.ts acme --standalone --license "MIT OR Apache-2.0"
```

The value is validated as an SPDX identifier or expression before anything is written; a malformed one fails at parse time rather than landing in a `package.json` npm will later reject. This is a syntax check, not a lookup against the SPDX license list — `LicenseRef-<name>` is accepted deliberately.

Examples:

```
bun src/cli.ts --spec fixtures/sentry.spec.json --dry-run
bun src/cli.ts --spec fixtures/sentry.spec.json --out-dir /tmp/sentry-preview
bun src/cli.ts --spec fixtures/zzstandalone.spec.json --standalone --out-dir /tmp/zzstandalone-preview
```

## The golden-fixture diff harness

`fixtures/*.spec.json` are hand-written specs modelled on real connectors already in the Nimbus monorepo. The harness regenerates each one in memory and byte-diffs it against the real file on disk, so the acceptance bar for the generator is "reproduces a real connector exactly," not "produces something that looks plausible."

```
bun run diff:golden                                    # all fixtures, resolves Nimbus by sibling-dir/env probing
bun run diff:golden sentry --nimbus-root C:\gitrep\Nimbus
bun run diff:golden sentry datadog --nimbus-root D:\Nimbus
```

`--nimbus-root <path>` points at a Nimbus checkout explicitly. Resolution order if omitted: `--nimbus-root` flag, then `$NIMBUS_ROOT`, then a sibling directory of this repo named `Nimbus` or `nimbus`. A resolved path must contain the marker file `packages/mcp-connectors/shared/mcp-tool-kit.ts`, or resolution fails loudly rather than producing a wall of missing-file errors.

Each fixture's expected set of byte-identical file paths (out of 6) is checked in at `fixtures/expectations.json`. The harness fails if reality diverges from that set **in either direction** — a file that stopped matching, or one that newly matches without being declared, which would leave the expectations file and the design doc's gap report stale.

It records *which* files match rather than how many, deliberately: for a partial fixture such as `discord` (3 of 6), a count alone reports PASS when a change newly matches `README.md` while breaking `package.json`.

## The acceptance harness

`bun run acceptance <nimbus-root>` proves a generated connector doesn't just diff cleanly against a real one, but actually compiles and lints **inside** a live Nimbus checkout: it generates a throwaway `zzscratch` connector into `packages/mcp-connectors/zzscratch/`, runs `tsc --noEmit`, `biome check`, and `bun run audit:package-readmes` against it, then deletes it — via `try/finally`, so the scratch connector is removed even if generation or a check throws. It finishes by asserting `git status --short packages/mcp-connectors/` is empty in the target checkout, so a bug can never leave someone else's working tree dirty.

```
bun run acceptance C:\gitrep\Nimbus
```

## The standalone acceptance harness

Stage A's acceptance harness proves a monorepo-target connector against a live Nimbus checkout. There is no equivalent live ground truth for standalone connectors — no standalone Nimbus connector exists yet — so `bun run standalone-acceptance <sdk-root>` substitutes a live end-to-end run: generate a `--standalone` connector into a temp directory outside the monorepo, point its `@nimbus-dev/sdk` dependency at a local, **built** SDK checkout (`file:<sdk-root>/sdks/typescript`, since 1.11.0 is not on npm yet), `bun install`, `bunx tsc --noEmit`, run the generated package's own `bun run typecheck` and `bun run lint` scripts (which resolve `tsc` and `biome` through its own `node_modules`, and re-check the emitted formatting and import order against the emitted `biome.json`), assert no `../../` import escapes `src/`, drive the server over real MCP stdio (`initialize` → `tools/list`, no credentials in the environment) against both `src/server.ts` and the `bun run build`-produced `dist/server.js`, then remove the temp directory whether or not any step threw.

```
bun run standalone-acceptance C:\gitrep\nimbus-sdk
```

`<sdk-root>` may be given positionally or as `--sdk-root <path>`, and resolves the same way `--nimbus-root` does: the argument, then `$NIMBUS_SDK_ROOT`, then a sibling directory of this repo named `nimbus-sdk`, requiring the marker file `sdks/typescript/package.json`.

The SDK must already be built (`dist/connector-kit/index.js` present), because `bunx tsc --noEmit` resolves the kit's types from `dist/connector-kit/index.d.ts` and the `node_modules` check asserts `dist/connector-kit/index.js` is on disk. That is genuine `dist` coverage for **types** and for **install-time existence** — but not for runtime JS, and this harness does *not* exercise the resolution path a real npm consumer takes. Two reasons: the SDK declares `"files": ["dist", "src"]`, so a `file:` dependency installs both; and Bun applies the SDK's `"bun"` export condition, which points `./connector-kit` at TypeScript source (`src/connector-kit/index.ts`), so both `bun src/server.ts` and `bun dist/server.js` run the kit from source. Runtime coverage of the built `dist` JS is the SDK's own `node-smoke` CI job (`sdks/typescript/scripts/smoke-esm.mjs`), not this harness.

## Development

```
bun test                              # unit tests for the emitters, independent of any monorepo checkout
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
```

`generate(spec)` (pure, no filesystem/env/clock access) and `formatAll(files)` (the only stage that touches Biome) are split deliberately so the emitters are unit-testable without a monorepo, and so the CLI, `--dry-run`, and the golden harness all format through the identical code path. See the design doc's "Generation is a pure function" section for the full rationale.

## License

[MIT](./LICENSE).
