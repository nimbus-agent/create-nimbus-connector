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
};

/** Guards against a flag whose value was omitted, e.g. a trailing `--foo` with nothing after it. */
export function takeValue(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i];
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { dryRun: false, standalone: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--standalone") opts.standalone = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--spec") opts.specPath = takeValue(argv, ++i, "--spec");
    else if (a === "--out-dir") opts.outDir = takeValue(argv, ++i, "--out-dir");
    else if (a === "--license") opts.license = validateLicense(takeValue(argv, ++i, "--license"));
    else if (a === "--gateway-wiring") {
      opts.gatewayWiring = takeValue(argv, ++i, "--gateway-wiring");
    } else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else opts.name = a;
  }
  if (opts.name !== undefined && opts.specPath !== undefined) {
    throw new Error(
      "--spec supplies the connector name from the spec file; a positional name is redundant " +
        "and was probably a mistake — remove one.",
    );
  }
  // Fail loudly rather than ignoring the flag. A user who believes they set a license and
  // did not is a worse outcome than an error, and every other flag conflict in this CLI
  // (a positional name alongside --spec, an unknown flag, a valueless flag) already errors.
  if (opts.license !== undefined && !opts.standalone) {
    throw new Error(
      `--license applies to --standalone output only, and was not ignored: a monorepo-target ` +
        `connector is ${MONOREPO_LICENSE} unconditionally, because it lives inside the AGPL ` +
        `Nimbus repo and imports AGPL code from ../../shared/*. Add --standalone, or drop ` +
        `--license.`,
    );
  }
  // Same rationale as --license above: a flag with no effect is a worse outcome silently
  // ignored than loudly rejected.
  if (opts.force && opts.gatewayWiring === undefined) {
    throw new Error("--force only applies to --gateway-wiring output. Add it, or drop --force.");
  }
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

/** Exported for scripts/acceptance.ts (Task 18) — must stay side-effect-free besides disk I/O. */
export async function writeFiles(files: readonly GeneratedFile[], outDir: string): Promise<void> {
  for (const f of files) {
    const target = join(outDir, ...f.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.content, "utf8");
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  const opts = parseCliArgs(argv);
  const spec =
    opts.specPath !== undefined
      ? parseSpec(JSON.parse(await Bun.file(opts.specPath).text()))
      : promptForSpec(opts.name);

  const target = opts.standalone ? "standalone" : "monorepo";
  const outDir =
    opts.outDir ?? (opts.standalone ? spec.name : join("packages", "mcp-connectors", spec.name));
  // Opt-in only: undefined unless --gateway-wiring was passed, so normal generation is
  // entirely unaffected — no new console output, no new disk writes, no new failure mode.
  const gatewayWiringDir =
    opts.gatewayWiring === undefined
      ? undefined
      : join(opts.gatewayWiring, "packages", "gateway", "src", "connectors");

  await initFormatter();
  if (!formatterAvailable()) {
    console.error(
      `note: ${formatterUnavailableReason() ?? "the formatter is unavailable."}\n` +
        "      to format the output afterwards:\n\n" +
        `        cd ${outDir} && bunx @biomejs/biome format --write .\n`,
    );
  }

  // generate() and formatAll() are synchronous — do not await them.
  // exactOptionalPropertyTypes: spread rather than pass `license: undefined`, which would
  // trip generate()'s monorepo guard on `!== undefined`.
  const files = formatAll(
    generate(spec, { target, ...(opts.license === undefined ? {} : { license: opts.license }) }),
  );
  // emitWiring() throws when the spec has no tool named "*_list". Computed alongside the
  // main package, before either is written, so a spec that cannot be wired fails loudly
  // rather than leaving the connector package written and its wiring silently skipped.
  const wiringFiles = gatewayWiringDir === undefined ? undefined : formatAll(emitWiring(spec));
  // Checked before dry-run too, so a preview accurately reports what a real run would do.
  if (wiringFiles !== undefined && gatewayWiringDir !== undefined) {
    assertWiringTargetsAbsent(gatewayWiringDir, wiringFiles, opts.force);
  }

  if (opts.dryRun) {
    console.log(`Would write ${files.length} files to ${outDir}/\n`);
    console.log(renderTree(files));
    if (wiringFiles !== undefined && gatewayWiringDir !== undefined) {
      console.log(
        `\nWould write ${wiringFiles.length} Gateway wiring file(s) to ${gatewayWiringDir}/\n`,
      );
      console.log(renderTree(wiringFiles));
      console.log(`\n${renderWiringInstructions(spec)}`);
    }
    return;
  }

  await writeFiles(files, outDir);
  console.log(`Created ${outDir}/ (${files.length} files)`);

  if (wiringFiles !== undefined && gatewayWiringDir !== undefined) {
    await writeFiles(wiringFiles, gatewayWiringDir);
    console.log(`\nWrote Gateway wiring for ${spec.name} to ${gatewayWiringDir}/`);
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
