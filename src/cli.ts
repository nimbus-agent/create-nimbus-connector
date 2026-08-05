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
import { promptForSpec } from "./prompts.ts";
import { parseSpec } from "./spec.ts";
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
};

/** Every flag parseFlags accepts. Single source for the unknown-flag suggestion. */
const KNOWN_FLAGS = [
  "--dry-run",
  "--force",
  "--from-connector",
  "--gateway-wiring",
  "--help",
  "--license",
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
  const opts: CliOptions = { dryRun: false, standalone: false, force: false, partial: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--standalone") opts.standalone = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--partial") opts.partial = true;
    else if (a === "--spec") opts.specPath = takeValue(argv, ++i, "--spec");
    else if (a === "--out-dir") opts.outDir = takeValue(argv, ++i, "--out-dir");
    else if (a === "--license") opts.license = validateLicense(takeValue(argv, ++i, "--license"));
    else if (a === "--gateway-wiring") {
      opts.gatewayWiring = takeValue(argv, ++i, "--gateway-wiring");
    } else if (a === "--from-connector") {
      opts.fromConnector = takeValue(argv, ++i, "--from-connector");
    } else if (a.startsWith("--")) throw new Error(unknownFlagMessage(a));
    else opts.name = a;
  }
  return opts;
}

/**
 * Every flag combination this CLI refuses, all instances of one rule: a flag that would
 * have no effect is a worse outcome silently ignored than loudly rejected.
 */
function assertFlagCombination(opts: CliOptions): void {
  if (opts.name !== undefined && opts.specPath !== undefined) {
    throw new Error(
      "--spec supplies the connector name from the spec file; a positional name is redundant " +
        "and was probably a mistake — remove one.",
    );
  }
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

export async function main(argv: readonly string[]): Promise<void> {
  if (await handleInfoFlags(argv)) return;

  const opts = parseCliArgs(argv);

  if (opts.fromConnector !== undefined) {
    // Lazy: a static import would pull @babel/parser into the module graph for every command,
    // so a consumer without the optionalDependency could not even run --dry-run. Task 3's
    // step 6 is the check that this stays true.
    const { initParser, parserAvailable, parserUnavailableReason } = await import(
      "./derive/ast.ts"
    );
    const { deriveFromDirectory, renderBlockers } = await import("./derive/from-connector.ts");
    await initParser();
    if (!parserAvailable())
      throw new Error(parserUnavailableReason() ?? "the parser is unavailable.");

    const result = await deriveFromDirectory(opts.fromConnector, { partial: opts.partial });
    if (!result.ok) {
      // Printed, not thrown. `blocked` is a RESULT — the top-level catcher formats a thrown
      // Error as one prefixed line, which would mangle a multi-line report and repeat the
      // program name. The throw below is only how this process exits non-zero.
      console.error(renderBlockers(opts.fromConnector, result.blockers));
      throw new Error(`--from-connector: ${opts.fromConnector} could not be read into a spec.`);
    }
    console.log(JSON.stringify(result.spec, null, 2));
    for (const note of result.notes) console.error(`note: ${note}`);
    if (result.target === "standalone") {
      console.error("note: read from a standalone package — generate with --standalone.");
    }
    return;
  }

  const spec =
    opts.specPath !== undefined
      ? parseSpec(await readSpecFile(opts.specPath))
      : promptForSpec(opts.name);

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
