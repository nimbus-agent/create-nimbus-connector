#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generate } from "./emit/index.ts";
import {
  formatAll,
  formatterAvailable,
  formatterUnavailableReason,
  initFormatter,
} from "./format.ts";
import { promptForSpec } from "./prompts.ts";
import { parseSpec } from "./spec.ts";
import { displayPath, type GeneratedFile } from "./types.ts";

export type CliOptions = {
  name?: string;
  specPath?: string;
  outDir?: string;
  dryRun: boolean;
  standalone: boolean;
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
  const opts: CliOptions = { dryRun: false, standalone: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--standalone") opts.standalone = true;
    else if (a === "--spec") opts.specPath = takeValue(argv, ++i, "--spec");
    else if (a === "--out-dir") opts.outDir = takeValue(argv, ++i, "--out-dir");
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else opts.name = a;
  }
  if (opts.name !== undefined && opts.specPath !== undefined) {
    throw new Error(
      "--spec supplies the connector name from the spec file; a positional name is redundant " +
        "and was probably a mistake — remove one.",
    );
  }
  return opts;
}

export function renderTree(files: readonly GeneratedFile[]): string {
  return files
    .map((f) => `  ${displayPath(f.path).padEnd(28)} ${Buffer.byteLength(f.content)} bytes`)
    .join("\n");
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

  await initFormatter();
  if (!formatterAvailable()) {
    console.error(
      `note: ${formatterUnavailableReason() ?? "the formatter is unavailable."}\n` +
        "      to format the output afterwards:\n\n" +
        `        cd ${outDir} && bunx @biomejs/biome format --write .\n`,
    );
  }

  // generate() and formatAll() are synchronous — do not await them.
  const files = formatAll(generate(spec, { target }));

  if (opts.dryRun) {
    console.log(`Would write ${files.length} files to ${outDir}/\n`);
    console.log(renderTree(files));
    return;
  }

  await writeFiles(files, outDir);
  console.log(`Created ${outDir}/ (${files.length} files)`);
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
