#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generate } from "./emit/index.ts";
import { emitWiring, renderWiringInstructions } from "./emit/wiring.ts";
import {
  formatAll,
  formatterAvailable,
  formatterUnavailableReason,
  initFormatter,
} from "./format.ts";
import { MARKER } from "./golden/resolve.ts";
import { MONOREPO_LICENSE, validateLicense } from "./license.ts";
// Statically imported, unlike src/derive/, which is behind a dynamic import because it needs the
// optional @babel/parser. This reader's only dependency is zod, already in the graph via spec.ts.
import {
  type LoadedDocument,
  listOperations,
  listSkippedOperations,
  loadDocument,
  type Operation,
  type SkippedOperation,
} from "./openapi/document.ts";
import type { Refusal } from "./openapi/operation.ts";
import type { OpenApiDocument } from "./openapi/schema.ts";
import { assembleSpec } from "./openapi/spec.ts";
import { promptForSpec } from "./prompts.ts";
import { type ConnectorSpec, parseSpec } from "./spec.ts";
import { displayPath, type GeneratedFile } from "./types.ts";

export type CliOptions = {
  name?: string;
  specPath?: string;
  outDir?: string;
  license?: string;
  dryRun: boolean;
  standalone: boolean;
  /** --gateway-wiring <nimbus-root>: opt-in, off by default. See emitWiring's module doc. */
  gatewayWiring?: string;
  /**
   * Fix round 1, CRITICAL 2: --gateway-wiring refuses to overwrite an existing target file
   * (a hand-authored real connector, or Gateway wiring already filled in) unless this is set.
   */
  force: boolean;
  /** --from-connector <dir>: read an existing connector directory and print its derived spec. */
  fromConnector?: string;
  /**
   * --partial: with --from-connector, emit a DRAFT spec instead of only a blocker report when
   * derivation fails. The draft carries PARTIAL_MARKER, which ConnectorSpecSchema (a
   * z.strictObject) refuses by construction — see src/derive/from-connector.ts.
   */
  partial: boolean;
  /** --from-openapi <doc>: read an OpenAPI 3 document. See src/openapi/document.ts. */
  fromOpenapi?: string;
  /** --list-operations: with --from-openapi, print the operations the document declares. */
  listOperations: boolean;
  /**
   * --op <operationId>, repeatable: the operations that become tools, in the order named.
   *
   * Order is not cosmetic — src/openapi/spec.ts assembles tools in the order it is handed them,
   * and `tools` order is the order they are registered in the generated server.
   */
  ops: string[];
};

/** Every flag parseFlags accepts. Single source for the unknown-flag suggestion. */
const KNOWN_FLAGS = [
  "--dry-run",
  "--force",
  "--from-connector",
  "--from-openapi",
  "--gateway-wiring",
  "--help",
  "--license",
  "--list-operations",
  "--op",
  "--out-dir",
  "--partial",
  "--spec",
  "--standalone",
  "--version",
] as const;

/** Levenshtein distance, for suggesting the flag a typo probably meant. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost));
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * `Unknown flag: --standlone` and nothing else leaves the user to spot a transposition by
 * eye. The threshold is deliberately tight — a suggestion that is merely the closest of a
 * short list, rather than actually close, sends people to the wrong flag with confidence.
 */
function unknownFlagMessage(flag: string): string {
  const ranked = KNOWN_FLAGS.map((k) => ({ k, d: editDistance(flag, k) })).sort(
    (x, y) => x.d - y.d,
  );
  const best = ranked[0]!;
  const suffix = best.d <= 3 ? ` Did you mean ${best.k}?` : " Run with --help to see the flags.";
  return `Unknown flag: ${flag}.${suffix}`;
}

/** Guards against a flag whose value was omitted, e.g. a trailing `--foo` with nothing after it. */
export function takeValue(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i];
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/** Flag → option, with no cross-flag validation: that is assertFlagCombination's job. */
function parseFlags(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    dryRun: false,
    standalone: false,
    force: false,
    partial: false,
    listOperations: false,
    ops: [],
  };
  // A switch rather than the else-if chain this replaced: every arm tests the same value for
  // equality, which is what a switch says and what a chain of `else if (a === …)` only implies.
  // `++i` inside an arm consumes that flag's value, so the loop's own counter skips it.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--standalone":
        opts.standalone = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--partial":
        opts.partial = true;
        break;
      case "--list-operations":
        opts.listOperations = true;
        break;
      case "--op":
        opts.ops.push(takeValue(argv, ++i, "--op"));
        break;
      case "--spec":
        opts.specPath = takeValue(argv, ++i, "--spec");
        break;
      case "--out-dir":
        opts.outDir = takeValue(argv, ++i, "--out-dir");
        break;
      case "--license":
        opts.license = validateLicense(takeValue(argv, ++i, "--license"));
        break;
      case "--gateway-wiring":
        opts.gatewayWiring = takeValue(argv, ++i, "--gateway-wiring");
        break;
      case "--from-connector":
        opts.fromConnector = takeValue(argv, ++i, "--from-connector");
        break;
      case "--from-openapi":
        opts.fromOpenapi = takeValue(argv, ++i, "--from-openapi");
        break;
      default:
        if (a.startsWith("--")) throw new Error(unknownFlagMessage(a));
        opts.name = a;
    }
  }
  return opts;
}

/**
 * Every flag combination this CLI refuses, all instances of one rule: a flag that would
 * have no effect is a worse outcome silently ignored than loudly rejected.
 *
 * **The call order below is the contract**, and each group's own comment says why it sits where it
 * does: the two "this command writes nothing" groups run ahead of the per-flag prerequisites,
 * because a prerequisite's advice ("add --standalone") is actively wrong when the flag it names is
 * itself refused by the group above. The groups were a single 200-line body until the ordering
 * they encode was worth reading on one screen; nothing about which check runs when has changed.
 */
function assertFlagCombination(opts: CliOptions): void {
  assertSpecSuppliesTheName(opts);
  assertFromConnectorGeneratesNothing(opts);
  assertFromOpenapiGeneratesNothing(opts);
  assertDocumentSelection(opts);
  assertFlagPrerequisites(opts);
  assertFromConnectorSpecSources(opts);
}

function assertSpecSuppliesTheName(opts: CliOptions): void {
  if (opts.name !== undefined && opts.specPath !== undefined) {
    throw new Error(
      "--spec supplies the connector name from the spec file; a positional name is redundant " +
        "and was probably a mistake — remove one.",
    );
  }
}

function assertFromConnectorGeneratesNothing(opts: CliOptions): void {
  // --from-connector only ever reads a directory and prints its derived spec to stdout — it
  // generates nothing and writes nothing, so every flag that shapes a WRITE is dead weight
  // rather than merely redundant. Checked as its own group, ahead of each flag's own generic
  // rule below (e.g. --license normally only needs --standalone), so a combination like
  // --from-connector --standalone --license MIT — where BOTH flags are dead — reports the
  // reason specific to --from-connector rather than "add --standalone", which would be actively
  // wrong advice here since --standalone itself is refused two checks below.
  if (opts.fromConnector !== undefined && opts.outDir !== undefined) {
    throw new Error(
      "--from-connector always prints its derived spec to stdout; --out-dir names a directory " +
        "to WRITE a package into, and this command writes no package. Drop --out-dir.",
    );
  }
  if (opts.fromConnector !== undefined && opts.standalone) {
    throw new Error(
      "--from-connector reads its target (monorepo or standalone) FROM the connector directory " +
        "and prints it as a stderr note — it does not generate a package for --standalone to " +
        "shape. Drop --standalone.",
    );
  }
  if (opts.fromConnector !== undefined && opts.license !== undefined) {
    throw new Error(
      "--license sets the SPDX field of a package this command would generate, and " +
        "--from-connector generates no package — it only reads one and prints its spec. Drop " +
        "--license.",
    );
  }
  if (opts.fromConnector !== undefined && opts.dryRun) {
    throw new Error(
      "--from-connector never writes files, with or without --dry-run — the two flags claim " +
        "the same thing twice. Drop --dry-run.",
    );
  }
  // The gap in this group the --from-openapi group's comment claimed was closed. --force alone
  // reports "only applies to --gateway-wiring. Add it, or drop --force." — and adding
  // --gateway-wiring is refused four checks below, so following the first half of that advice
  // never reaches a valid command. Wrong advice is worse than none.
  if (opts.fromConnector !== undefined && opts.force) {
    throw new Error(
      "--force lets --gateway-wiring overwrite files it did not create, and --from-connector " +
        "writes no files at all — adding --gateway-wiring to give --force something to apply " +
        "to is refused too. Drop --force.",
    );
  }
}

function assertFromOpenapiGeneratesNothing(opts: CliOptions): void {
  // The --from-openapi group, checked ahead of each flag's own generic rule for exactly the
  // reason the --from-connector group above is: this command prints a spec to stdout and writes
  // nothing, so every flag that shapes a WRITE is dead here, and reporting "--license needs
  // --standalone" would send the user to a flag that is equally dead. Grouped into one message
  // rather than five checks because they all fail for one reason, and naming every dead flag at
  // once beats three successive runs each rejecting the next one.
  if (opts.fromOpenapi !== undefined) {
    const dead = [
      opts.outDir === undefined ? undefined : "--out-dir",
      opts.standalone ? "--standalone" : undefined,
      opts.license === undefined ? undefined : "--license",
      opts.dryRun ? "--dry-run" : undefined,
      opts.gatewayWiring === undefined ? undefined : "--gateway-wiring",
      // --force and --partial are dead here for one more step than the rest: each is gated on a
      // flag that is ITSELF refused alongside --from-openapi, so following the first line of
      // "--force only applies to --gateway-wiring" never reaches a valid command.
      opts.force ? "--force" : undefined,
      opts.partial ? "--partial" : undefined,
    ].filter((f): f is string => f !== undefined);
    if (dead.length > 0) {
      throw new Error(
        `--from-openapi reads a document and prints a spec to stdout — it generates no package, ` +
          `so ${dead.join(", ")} would be silently ignored. Drop ${dead.length === 1 ? "it" : "them"}, ` +
          `then generate from the printed spec with --spec.`,
      );
    }
  }
  if (opts.fromOpenapi !== undefined && opts.fromConnector !== undefined) {
    throw new Error(
      "--from-openapi reads an OpenAPI document and --from-connector reads a connector " +
        "directory; both print a spec, so passing them together means one would be discarded. " +
        "Keep one.",
    );
  }
  if (opts.fromOpenapi !== undefined && opts.specPath !== undefined) {
    throw new Error(
      "--from-openapi derives a spec from a document and --spec reads one from a file; passing " +
        "both means one would be discarded. Keep one.",
    );
  }
  if (opts.fromOpenapi !== undefined && opts.name !== undefined) {
    throw new Error(
      "--from-openapi takes the connector name from the document's info.title; a positional " +
        "name is redundant and was probably a mistake — remove one.",
    );
  }
}

function assertDocumentSelection(opts: CliOptions): void {
  // The same trap the --force check above closes. --list-operations and --op only mean anything
  // against an OpenAPI document, so on their own they say "Add --from-openapi <doc>" — which is
  // wrong advice when a flag that REFUSES --from-openapi is already present. --spec and
  // --from-connector each supply a spec of their own and are both refused alongside it, so
  // following the first half of that advice never reaches a valid command. Checked ahead of the
  // two rules below, which give the advice.
  const documentOnly = [
    opts.listOperations ? "--list-operations" : undefined,
    opts.ops.length > 0 ? "--op" : undefined,
  ].filter((f): f is string => f !== undefined);
  // Same shape as `documentOnly` above, and in priority order: --from-connector is named first
  // when both are present, because it is the one that wins downstream.
  const suppliesASpec = [
    opts.fromConnector !== undefined ? "--from-connector" : undefined,
    opts.specPath !== undefined ? "--spec" : undefined,
  ].find((f) => f !== undefined);
  if (documentOnly.length > 0 && opts.fromOpenapi === undefined && suppliesASpec !== undefined) {
    throw new Error(
      `${documentOnly.join(" and ")} read an OpenAPI document, and ${suppliesASpec} supplies a ` +
        `spec of its own — adding --from-openapi is refused alongside ${suppliesASpec}, since ` +
        "both would produce a spec. Keep one.",
    );
  }
  if (opts.listOperations && opts.fromOpenapi === undefined) {
    throw new Error(
      "--list-operations lists the operations of an OpenAPI document, and no document was " +
        "named. Add --from-openapi <doc>.",
    );
  }
  if (opts.ops.length > 0 && opts.fromOpenapi === undefined) {
    throw new Error(
      "--op selects an operation of an OpenAPI document by operationId, and no document was " +
        "named. Add --from-openapi <doc>.",
    );
  }
  if (opts.listOperations && opts.ops.length > 0) {
    throw new Error(
      "--list-operations prints what a document declares and --op assembles a spec from a " +
        "selection of it; both read the same document, and only one of them can produce output, " +
        "so passing both means one would be discarded. List first, then run again with --op.",
    );
  }
  // The pinned answer to "what does a bare --from-openapi do", which stood provisionally as
  // "pass --list-operations" only because assembling a spec was not yet wired.
  //
  // It refuses rather than mapping every operation, and the reason is not caution. A connector's
  // tool set is a product decision the document does not state: a document describes an API,
  // where a Nimbus connector exposes the handful of operations an agent should be able to call,
  // and taking all of them would put every endpoint of the API into one connector. The mechanical
  // half is just as decisive — src/openapi/spec.ts refuses the WHOLE spec when any selected
  // operation refuses (an operation maps completely or not at all), so "everything" would mean a
  // single unmappable operation, of a kind most real documents carry, yielding no spec and a wall
  // of refusals about operations the author never wanted.
  if (opts.fromOpenapi !== undefined && !opts.listOperations && opts.ops.length === 0) {
    throw new Error(
      "--from-openapi: no operation was selected, and which operations become tools is a choice " +
        "this reader will not make for you — a document describes a whole API, where a connector " +
        "exposes the few operations an agent should call. Run --list-operations to see the " +
        "operationIds this document declares, then pass one or more --op <operationId>.",
    );
  }
}

/** Each flag whose effect depends on another flag being present, checked after the groups above. */
function assertFlagPrerequisites(opts: CliOptions): void {
  // A user who believes they set a license and did not is a worse outcome than an error.
  if (opts.license !== undefined && !opts.standalone) {
    throw new Error(
      `--license applies to --standalone output only, and was not ignored: a monorepo-target ` +
        `connector is ${MONOREPO_LICENSE} unconditionally, because it lives inside the AGPL ` +
        `Nimbus repo and imports AGPL code from ../../shared/*. Add --standalone, or drop ` +
        `--license.`,
    );
  }
  if (opts.force && opts.gatewayWiring === undefined) {
    throw new Error("--force only applies to --gateway-wiring output. Add it, or drop --force.");
  }
  if (opts.partial && opts.fromConnector === undefined) {
    throw new Error(
      "--partial only applies to --from-connector output. Add it, or drop --partial.",
    );
  }
  // --gateway-wiring is monorepo-target only, as the README says, and it was the one flag
  // conflict here that was silently accepted instead. It is not merely ineffective under
  // --standalone: it would still write two files into the Nimbus checkout, importing
  // "../sync/types.ts" and registering a Syncable, for a connector deliberately generated to
  // live outside that repository.
  if (opts.gatewayWiring !== undefined && opts.standalone) {
    throw new Error(
      "--gateway-wiring applies to the monorepo target only, and was not ignored: it writes " +
        "<name>-sync.ts and <name>-mapping.ts into the Nimbus Gateway, which a --standalone " +
        "connector does not live in and is not registered with. Drop --standalone, or drop " +
        "--gateway-wiring.",
    );
  }
}

/** The --from-connector rules that are about where a spec comes from, rather than about writes. */
function assertFromConnectorSpecSources(opts: CliOptions): void {
  if (opts.fromConnector !== undefined && opts.specPath !== undefined) {
    throw new Error(
      "--from-connector derives a spec from an existing connector and --spec reads one from a " +
        "file; passing both means one would be discarded. Keep one.",
    );
  }
  if (opts.fromConnector !== undefined && opts.name !== undefined) {
    throw new Error(
      "--from-connector takes the connector name from the directory it reads; a positional " +
        "name is redundant and was probably a mistake — remove one.",
    );
  }
  if (opts.fromConnector !== undefined && opts.gatewayWiring !== undefined) {
    throw new Error(
      "--from-connector prints a spec and writes nothing, so --gateway-wiring has nothing to " +
        "attach to. Derive the spec first, then generate from it with --spec.",
    );
  }
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const opts = parseFlags(argv);
  assertFlagCombination(opts);
  return opts;
}

export function renderTree(files: readonly GeneratedFile[]): string {
  return files
    .map((f) => `  ${displayPath(f.path).padEnd(28)} ${Buffer.byteLength(f.content)} bytes`)
    .join("\n");
}

/**
 * Fix round 1, CRITICAL 2: writeFiles() overwrites unconditionally, and re-running
 * --gateway-wiring reused it — silently reverting a hand-filled mapping back to a throwing
 * stub, or worse, destroying a real hand-authored connector: Nimbus already ships
 * newrelic-sync.ts and datadog-sync.ts, with a completely different shape, so
 * --gateway-wiring on a connector named "newrelic" would have overwritten one. That is
 * exactly the "silent bad patch to a file this project does not own" risk that is this
 * feature's own reason for refusing to edit the registration files — writeFiles() must not
 * reintroduce it for the two files it DOES write. Checked, not caught: existsSync is
 * synchronous, so this runs to completion (and can throw) before any write begins.
 */
export function assertWiringTargetsAbsent(
  dir: string,
  files: readonly GeneratedFile[],
  force: boolean,
): void {
  if (force) return;
  for (const f of files) {
    const target = join(dir, ...f.path);
    if (existsSync(target)) {
      throw new Error(
        `${target} already exists. --gateway-wiring refuses to overwrite a file it did not ` +
          "create — it may be a hand-authored real connector, or Gateway wiring already " +
          "filled in. Pass --force to overwrite it anyway, or remove --gateway-wiring to skip " +
          "this output.",
      );
    }
  }
}

/**
 * --gateway-wiring's argument is a path into someone else's repository, and nothing checked
 * it was that repository. A typo, or the wrong checkout, silently scaffolded
 * `packages/gateway/src/connectors/` inside whatever directory was named — creating a
 * plausible-looking tree in the wrong place and reporting success.
 *
 * This is the same rule the feature already applies to individual files (it refuses to
 * overwrite one it did not create), extended to the destination itself. MARKER is the same
 * file `diff:golden` uses to decide what counts as a Nimbus checkout, so the two agree on
 * the question by construction.
 */
export function assertNimbusRoot(root: string): string {
  if (existsSync(join(root, MARKER))) return root;
  throw new Error(
    `--gateway-wiring: ${root} does not look like a Nimbus checkout (expected ${MARKER} ` +
      `inside it). Wiring files are written into <root>/packages/gateway/src/connectors/, ` +
      `so pointing this at the wrong directory would scaffold a Gateway tree where none ` +
      `belongs. Pass the root of your Nimbus monorepo.`,
  );
}

/** Exported for scripts/acceptance.ts (Task 18) — must stay side-effect-free besides disk I/O. */
export async function writeFiles(files: readonly GeneratedFile[], outDir: string): Promise<void> {
  for (const f of files) {
    const target = join(outDir, ...f.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.content, "utf8");
  }
}

/**
 * Usage text. Every flag here is one this CLI actually parses — parseFlags is the source of
 * truth, and test/cli.test.ts asserts the two agree, so a flag added without a line here is
 * a failing test rather than an undocumented feature.
 */
export const USAGE = `create-nimbus-connector — scaffold a Nimbus MCP connector package

Usage:
  bunx create-nimbus-connector <name>              interactive, monorepo target
  bunx create-nimbus-connector --spec <file>       from a connector spec JSON

Flags:
  --spec <file>            read the connector spec from <file> instead of prompting
  --out-dir <dir>          where to write (default: <name>/ standalone,
                           packages/mcp-connectors/<name>/ otherwise)
  --standalone             emit a self-contained package importing @nimbus-dev/sdk
  --license <id>           SPDX licence for --standalone output (default: UNLICENSED)
  --gateway-wiring <root>  also emit Nimbus Gateway sync/mapping skeletons (monorepo only)
  --force                  allow --gateway-wiring to overwrite existing target files
  --from-connector <dir>   read an existing connector directory and print its spec
  --partial                with --from-connector, emit a DRAFT spec instead of a blocker report
  --from-openapi <doc>     read an OpenAPI 3 document (JSON or YAML) and print a spec
  --list-operations        with --from-openapi, print each operationId, method and path
  --op <operationId>       with --from-openapi, select an operation to become a tool;
                           repeatable, and one is required (the tool set is yours to choose)
  --dry-run                print what would be written, write nothing
  --version                print the version
  --help                   show this message

Path templates interpolate \${arg.NAME} and \${env.NAME}, with an optional
|raw, |enc, |num or |bool mode. OpenAPI's {id} and Express's /:id are rejected
rather than emitted literally.`;

/**
 * Reads the spec file, turning the two failure modes a user actually hits into messages
 * that name the flag and the file. Before this, a missing file surfaced Node's raw
 * `ENOENT: no such file or directory, open 'nope.json'` and malformed JSON surfaced
 * `JSON Parse error: Expected '}'` with no indication of WHICH file was being parsed.
 */
async function readSpecFile(specPath: string): Promise<unknown> {
  let text: string;
  try {
    text = await Bun.file(specPath).text();
  } catch {
    throw new Error(`--spec: cannot read ${specPath}. Check the path exists and is readable.`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`--spec: ${specPath} is not valid JSON (${detail}).`);
  }
}

/**
 * `parseSpec` for a spec FILE, with one sentence about the published JSON Schema appended when
 * it refuses.
 *
 * The schema is generated from `ConnectorSpecSchema` and cannot carry its refinements — JSON
 * Schema has no way to express them — so a spec an editor calls valid can still be refused here.
 * That limit is stated in the schema document's own `description`, in README's *Editor support*
 * section and in ROADMAP, and all three require the reader to already be looking. This is where
 * they are not: they are looking at a CLI that just refused a file their editor called clean, and
 * nothing in `parseSpec`'s message mentions a schema at all.
 *
 * Appended HERE rather than inside `parseSpec`, on purpose. That message is one line per issue
 * and `test/spec.test.ts` asserts the exact line count, so a sentence added there would either
 * break the test or be excused by widening it. It also does not belong there: `parseSpec` is
 * called by `--from-connector`, `--from-openapi` and the interactive prompts, none of which
 * involve a file a user hand-edited against the schema.
 */
async function parseSpecFile(specPath: string): Promise<ConnectorSpec> {
  const input = await readSpecFile(specPath);
  try {
    return parseSpec(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${message}\n\nThe published JSON Schema checks STRUCTURE only — the cross-field rules, ` +
        "reserved identifiers and style requirements above are refinements it cannot express, " +
        "so an editor can call this file valid while this command refuses it. See README's " +
        '"Editor support: the published JSON Schema, and what it cannot check".',
    );
  }
}

/**
 * --help and --version. Handled before parseCliArgs, deliberately: both must work on their
 * own, and must not be refused by a flag-combination rule they have nothing to do with.
 *
 * Returns true when printing one of them WAS the whole job, so main can stop.
 */
async function handleInfoFlags(argv: readonly string[]): Promise<boolean> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return true;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
    console.log(pkg.version);
    return true;
  }
  return false;
}

/** Where to write, when --out-dir did not say. */
function resolveOutDir(opts: CliOptions, name: string): string {
  if (opts.outDir !== undefined) return opts.outDir;
  return opts.standalone ? name : join("packages", "mcp-connectors", name);
}

/** Tell the user how to format by hand, but only when we could not do it for them. */
function warnIfUnformatted(outDir: string): void {
  if (formatterAvailable()) return;
  console.error(
    `note: ${formatterUnavailableReason() ?? "the formatter is unavailable."}\n` +
      "      to format the output afterwards:\n\n" +
      `        cd ${outDir} && bunx @biomejs/biome format --write .\n`,
  );
}

/**
 * The --gateway-wiring output, or undefined when the flag was not passed.
 *
 * Directory and files travel together in one optional object because they are one decision:
 * previously they were two `undefined`-able locals that were always both set or both unset,
 * and all three use sites had to re-assert that with `a !== undefined && b !== undefined`
 * purely to convince the type checker of something the code already guaranteed.
 */
type WiringOutput = { readonly dir: string; readonly files: readonly GeneratedFile[] };

/** The document text, with the one failure a user actually hits named by flag and by file. */
async function readDocumentFile(docPath: string): Promise<LoadedDocument> {
  let text: string;
  try {
    text = await Bun.file(docPath).text();
  } catch {
    throw new Error(
      `--from-openapi: cannot read ${docPath}. Check the path exists and is readable.`,
    );
  }
  return loadDocument(text);
}

/**
 * `--from-openapi <doc> --list-operations`.
 *
 * One line per operation, so `--op` arguments can be copied straight off it — in the order the
 * document declares them, which is why src/openapi/schema.ts's path item declares no method keys.
 */
function listDocumentOperations({ doc, source }: LoadedDocument, docPath: string): void {
  const operations = listOperations(doc);
  const width = Math.max(0, ...operations.map((o) => o.operationId.length));
  for (const op of operations) {
    console.log(`${op.operationId.padEnd(width)}  ${op.method.padEnd(6)} ${op.path}`);
  }
  console.error(`note: read ${operations.length} operation(s) from ${source} ${docPath}`);
  // On stderr, so stdout stays a list of --op arguments that can be copied whole. Named rather
  // than omitted: an operation the reader can see but not offer is one the user would otherwise
  // hunt for in their own file, having been given no reason it is absent.
  for (const skipped of listSkippedOperations(doc)) {
    console.error(`note: skipped ${describeSkipped(skipped)} — ${skipped.detail}`);
  }
}

/**
 * One skipped operation, named the way both commands that mention it need.
 *
 * The `operationId` is included when there is one so that this listing and the refusal `--op`
 * produces for the same operation describe one thing rather than two: without it, the listing
 * says `head /health` and the refusal says `probeHealth`, and connecting them is the reader's
 * problem. Method and path come first because an operation with no `operationId` has nothing
 * else to be identified by.
 */
function describeSkipped(skipped: SkippedOperation): string {
  const named = skipped.operationId === undefined ? "" : `, operationId: ${skipped.operationId}`;
  return `${skipped.method} ${skipped.path} (${skipped.reason}${named})`;
}

/**
 * `--op` arguments → the operations to map, or every reason one of them could not be selected.
 *
 * Three diagnoses, and keeping them apart is this function's entire job — each is a different
 * thing for the user to do next:
 *
 * 1. **The document offers nothing selectable.** Checked first and reported once, as a fact about
 *    the document rather than once per `--op`. `assembleSpec` would answer this case with
 *    `no-operations`, whose message ends "run --list-operations and pass one or more --op" —
 *    circular advice for a document whose listing prints nothing. The reason the set is empty is
 *    in hand HERE (the reader reported it), so it is what gets printed.
 * 2. **The named operation was skipped.** `head`/`options`/`trace` and a mis-cased method key are
 *    reported by the reader and omitted from the selectable set rather than refusing the
 *    document — refusing forty mappable operations over one `HEAD /health` would defeat
 *    `--list-operations`. The hard refusal belongs here, at selection, and it must name the
 *    method as unsupported: "no such operation" for one the user is reading in their own document
 *    is a confidently wrong diagnosis.
 * 3. **The document does not contain it.** Only then, and with the operationIds that are
 *    available, because the likeliest cause is a typo or a stale listing.
 *
 * Every `--op` is checked before returning, so one run names every argument standing in the way —
 * the same rule `mapOperation` and `assembleSpec` follow.
 */
function selectOperations(doc: OpenApiDocument, ids: readonly string[]): SelectedOperations {
  const available = listOperations(doc);
  const skipped = listSkippedOperations(doc);

  if (available.length === 0) {
    // ONE refusal about the document, not one per --op: repeating "no such operation" for each
    // argument would describe the arguments, when the fact to report is that this document offers
    // none. Every skipped operation is listed with its own reason — the first one's is not
    // representative when a `head:` and a mis-cased `Post:` are both present.
    const skippedLines = skipped.map((s) => `    ${describeSkipped(s)} — ${s.detail}`);
    const refusal: Refusal =
      skipped.length === 0
        ? {
            kind: "no-operations",
            detail:
              "there is nothing for --op to select: this document declares no operation at " +
              "all. Check that it is the document you meant.",
          }
        : {
            kind: "no-selectable-operation",
            detail:
              "there is nothing for --op to select: every operation this document declares was " +
              `skipped.\n${skippedLines.join("\n")}`,
          };
    return { ok: false, refusals: [refusal] };
  }

  const byId = new Map(available.map((op) => [op.operationId, op]));
  const skippedById = new Map(
    skipped.flatMap((s) => (s.operationId === undefined ? [] : [[s.operationId, s] as const])),
  );

  const ops: Operation[] = [];
  const refusals: Refusal[] = [];
  for (const id of ids) {
    const op = byId.get(id);
    if (op !== undefined) {
      ops.push(op);
      continue;
    }
    const missing = skippedById.get(id);
    if (missing !== undefined) {
      refusals.push({
        kind: missing.reason,
        // The reason is the kind, so it is not repeated inside the sentence: what this adds is
        // WHICH method key and path the id the user typed resolves to, since that is the line
        // they have to go and change.
        detail:
          `--op ${id} names ${missing.method} ${missing.path}, which --list-operations reports ` +
          `as skipped and does not offer — ${missing.detail}`,
      });
      continue;
    }
    refusals.push({
      kind: "no-such-operation",
      detail:
        `--op ${id} names no operation in this document. It declares: ` +
        `${available.map((o) => o.operationId).join(", ")}.`,
    });
  }
  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, ops };
}

type SelectedOperations =
  | { ok: true; ops: readonly Operation[] }
  | { ok: false; refusals: readonly Refusal[] };

/**
 * Every reason a document could not become a spec, printed rather than thrown.
 *
 * Same shape as `renderBlockers` and for the same reason: the top-level catcher formats a thrown
 * Error as one prefixed line, which would mangle a multi-line report and repeat the program name.
 * Each label names a construct — the vocabulary src/openapi/document.ts, src/openapi/operation.ts
 * and src/openapi/spec.ts all refuse in.
 */
function renderOpenapiRefusals(docPath: string, refusals: readonly Refusal[]): string {
  const lines = refusals.map((r) => `  ${r.kind}: ${r.detail}`);
  return `cannot read ${docPath} into a spec. What stopped it:\n\n${lines.join("\n\n")}\n`;
}

/**
 * `--from-openapi <doc> --op <id>…`: the document and a selection of its operations as a spec.
 *
 * **The spec goes to stdout and everything else to stderr**, which is the reason this prints
 * rather than writing a file: `--from-openapi doc.yaml --op listWidgets > widgets.spec.json`
 * leaves a file that `--spec` reads directly, while the notes — each a `TODO:` recording
 * something the document could not state, or something the spec language could not carry
 * unchanged — stay on the terminal where the author will see them. A written file would have to
 * choose between putting the notes in it (and breaking the JSON) and dropping them (and losing
 * the record of what was assumed).
 */
function assembleDocumentSpec(loaded: LoadedDocument, docPath: string, ids: readonly string[]) {
  const selected = selectOperations(loaded.doc, ids);
  if (!selected.ok) return refuseDocument(docPath, selected.refusals);

  const assembled = assembleSpec(loaded.doc, selected.ops);
  if (!assembled.ok) return refuseDocument(docPath, assembled.refusals);

  console.log(JSON.stringify(assembled.spec, null, 2));
  console.error(
    `note: assembled ${selected.ops.length} operation(s) from ${loaded.source} ${docPath}`,
  );
  for (const note of assembled.notes) console.error(`note: ${note}`);
  // Not a note per placeholder: src/openapi/spec.ts marks every one of them in the spec itself,
  // so the printed file is the list. This says the file is a draft, which the file cannot.
  //
  // "style" and "syncInterval" are named separately rather than folded into the sentence: they
  // are placeholders too, but an enum and a positive integer cannot hold a "TODO:" marker, so a
  // note claiming every placeholder is marked would be false for exactly those two.
  console.error(
    'note: every "TODO:" in the printed spec is a value the document could not state. "style" ' +
      'and "syncInterval" carry a provisional value instead, neither being able to hold prose. ' +
      "Review both before generating.",
  );
}

/** Printed, not thrown, so the report keeps its shape; the throw is only how main exits 1. */
function refuseDocument(docPath: string, refusals: readonly Refusal[]): never {
  console.error(renderOpenapiRefusals(docPath, refusals));
  throw new Error(`--from-openapi: ${docPath} could not be read into a spec.`);
}

/**
 * `--from-connector <dir>`: the connector as a spec on stdout, or its blockers on stderr.
 *
 * Its own function for the reason `assembleDocumentSpec` and `listDocumentOperations` are: main()
 * is the dispatch between the commands, and a command's body inside the dispatch hides which of
 * the two it is.
 */
async function printDerivedSpec(dir: string, partial: boolean): Promise<void> {
  // Lazy: a static import would pull @babel/parser into the module graph for every command,
  // so a consumer without the optionalDependency could not even run --dry-run. Task 3's
  // step 6 is the check that this stays true.
  const { initParser, parserAvailable, parserUnavailableReason } = await import("./derive/ast.ts");
  const { deriveFromDirectory, renderBlockers } = await import("./derive/from-connector.ts");
  await initParser();
  if (!parserAvailable())
    throw new Error(parserUnavailableReason() ?? "the parser is unavailable.");

  const result = await deriveFromDirectory(dir, { partial });
  if (!result.ok) {
    // Printed, not thrown. `blocked` is a RESULT — the top-level catcher formats a thrown
    // Error as one prefixed line, which would mangle a multi-line report and repeat the
    // program name. The throw below is only how this process exits non-zero.
    console.error(renderBlockers(dir, result.blockers));
    throw new Error(`--from-connector: ${dir} could not be read into a spec.`);
  }
  console.log(JSON.stringify(result.spec, null, 2));
  for (const note of result.notes) console.error(`note: ${note}`);
  if (result.target === "standalone") {
    console.error("note: read from a standalone package — generate with --standalone.");
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  if (await handleInfoFlags(argv)) return;

  const opts = parseCliArgs(argv);

  if (opts.fromOpenapi !== undefined) {
    // One read for both commands. assertFlagCombination has already established that exactly one
    // of them was asked for, so this is a choice between two, not a fallthrough.
    const loaded = await readDocumentFile(opts.fromOpenapi);
    if (opts.listOperations) listDocumentOperations(loaded, opts.fromOpenapi);
    else assembleDocumentSpec(loaded, opts.fromOpenapi, opts.ops);
    return;
  }

  if (opts.fromConnector !== undefined) {
    await printDerivedSpec(opts.fromConnector, opts.partial);
    return;
  }

  await generatePackage(opts);
}

/** The default command: a spec (from `--spec` or the prompts) generated, previewed or written. */
async function generatePackage(opts: CliOptions): Promise<void> {
  const spec =
    opts.specPath !== undefined ? await parseSpecFile(opts.specPath) : promptForSpec(opts.name);

  const target = opts.standalone ? "standalone" : "monorepo";
  const outDir = resolveOutDir(opts, spec.name);
  // Opt-in only: undefined unless --gateway-wiring was passed, so normal generation is
  // entirely unaffected — no new console output, no new disk writes, no new failure mode.
  // Resolved here rather than beside the files below so that a --gateway-wiring pointed at
  // the wrong directory still fails before any generation work, exactly as it used to.
  const wiringDir =
    opts.gatewayWiring === undefined
      ? undefined
      : join(assertNimbusRoot(opts.gatewayWiring), "packages", "gateway", "src", "connectors");

  await initFormatter();
  warnIfUnformatted(outDir);

  // generate() and formatAll() are synchronous — do not await them.
  // exactOptionalPropertyTypes: spread rather than pass `license: undefined`, which would
  // trip generate()'s monorepo guard on `!== undefined`.
  const files = formatAll(
    generate(spec, { target, ...(opts.license === undefined ? {} : { license: opts.license }) }),
  );
  // emitWiring() throws when the spec has no tool named "*_list". Computed alongside the
  // main package, before either is written, so a spec that cannot be wired fails loudly
  // rather than leaving the connector package written and its wiring silently skipped.
  const wiring: WiringOutput | undefined =
    wiringDir === undefined ? undefined : { dir: wiringDir, files: formatAll(emitWiring(spec)) };
  // Checked before dry-run too, so a preview accurately reports what a real run would do.
  if (wiring !== undefined) assertWiringTargetsAbsent(wiring.dir, wiring.files, opts.force);

  if (opts.dryRun) {
    console.log(`Would write ${files.length} files to ${outDir}/\n`);
    console.log(renderTree(files));
    if (wiring !== undefined) {
      console.log(
        `\nWould write ${wiring.files.length} Gateway wiring file(s) to ${wiring.dir}/\n`,
      );
      console.log(renderTree(wiring.files));
      console.log(`\n${renderWiringInstructions(spec)}`);
    }
    return;
  }

  await writeFiles(files, outDir);
  console.log(`Created ${outDir}/ (${files.length} files)`);

  if (wiring !== undefined) {
    await writeFiles(wiring.files, wiring.dir);
    console.log(`\nWrote Gateway wiring for ${spec.name} to ${wiring.dir}/`);
    console.log(`\n${renderWiringInstructions(spec)}`);
  }
}

// Guarded so Task 18's scripts/acceptance.ts can import writeFiles without side effects.
// main() itself keeps throwing (stays testable); only this top-level guard turns a thrown
// Error into a clean single-line stderr message instead of an uncaught stack trace.
if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    console.error(`create-nimbus-connector: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
