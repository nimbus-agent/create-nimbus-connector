/**
 * The command line, parsed: every flag the CLI accepts, and every combination of them it refuses.
 *
 * Split out of src/cli.ts so the per-file coverage floor grades it. src/cli.ts is excluded from the
 * coverage metric because its `main()` is driven through the real binary in a subprocess, which Bun
 * does not instrument (bunfig.toml has the reasoning) — but this half never needed a subprocess:
 * test/cli.test.ts calls `parseCliArgs` directly, and while the parser lived in the excluded file
 * those tests counted toward no floor. A flag added here without a test now shows in the report
 * like any other gap.
 *
 * Nothing here reads or writes a file. `takeValue` is exported for the harnesses under scripts/,
 * which parse their own flags with it.
 */

import { MONOREPO_LICENSE, validateLicense } from "./license.ts";

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

/**
 * Every flag parseFlags accepts. Single source for the unknown-flag suggestion, and for the flags
 * takeOutDir refuses to take as a directory.
 */
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

/**
 * --out-dir's value, refusing one of this CLI's own flags in its place.
 *
 * takeValue only catches a value that is missing, so `acme --out-dir --dry-run` took --dry-run as
 * the directory: no dry run, and the package written into ./--dry-run/. Nothing downstream catches
 * it for --out-dir — the directory is created if it does not exist, so a swallowed flag becomes a
 * directory on disk rather than a failed lookup.
 *
 * Only the flags in KNOWN_FLAGS are refused, never every leading hyphen: -preview is a valid
 * relative directory, and one really named after a flag can still be given as ./--dry-run.
 */
function takeOutDir(argv: readonly string[], i: number): string {
  const dir = takeValue(argv, i, "--out-dir");
  if (KNOWN_FLAGS.some((flag) => flag === dir)) {
    throw new Error(
      `--out-dir requires a directory, and ${dir} is one of this CLI's flags — was the ` +
        `directory left out? A directory really named ${dir} can be given as ./${dir}.`,
    );
  }
  return dir;
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
        opts.outDir = takeOutDir(argv, ++i);
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
  if (opts.fromConnector === undefined) return;
  if (opts.outDir !== undefined) {
    throw new Error(
      "--from-connector always prints its derived spec to stdout; --out-dir names a directory " +
        "to WRITE a package into, and this command writes no package. Drop --out-dir.",
    );
  }
  if (opts.standalone) {
    throw new Error(
      "--from-connector reads its target (monorepo or standalone) FROM the connector directory " +
        "and prints it as a stderr note — it does not generate a package for --standalone to " +
        "shape. Drop --standalone.",
    );
  }
  if (opts.license !== undefined) {
    throw new Error(
      "--license sets the SPDX field of a package this command would generate, and " +
        "--from-connector generates no package — it only reads one and prints its spec. Drop " +
        "--license.",
    );
  }
  if (opts.dryRun) {
    throw new Error(
      "--from-connector never writes files, with or without --dry-run — the two flags claim " +
        "the same thing twice. Drop --dry-run.",
    );
  }
  // The gap in this group the --from-openapi group's comment claimed was closed. --force alone
  // reports "only applies to --gateway-wiring. Add it, or drop --force." — and adding
  // --gateway-wiring is refused four checks below, so following the first half of that advice
  // never reaches a valid command. Wrong advice is worse than none.
  if (opts.force) {
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
  if (opts.fromOpenapi === undefined) return;

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
  if (opts.fromConnector !== undefined) {
    throw new Error(
      "--from-openapi reads an OpenAPI document and --from-connector reads a connector " +
        "directory; both print a spec, so passing them together means one would be discarded. " +
        "Keep one.",
    );
  }
  if (opts.specPath !== undefined) {
    throw new Error(
      "--from-openapi derives a spec from a document and --spec reads one from a file; passing " +
        "both means one would be discarded. Keep one.",
    );
  }
  if (opts.name !== undefined) {
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
