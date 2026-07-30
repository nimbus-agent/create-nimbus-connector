import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generate } from "./emit/index.ts";
import { formatAll } from "./format.ts";
import { promptForSpec } from "./prompts.ts";
import { parseSpec } from "./spec.ts";
import { displayPath, type GeneratedFile } from "./types.ts";

export type CliOptions = {
  name?: string;
  specPath?: string;
  outDir?: string;
  dryRun: boolean;
};

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--spec") opts.specPath = argv[++i];
    else if (a === "--out-dir") opts.outDir = argv[++i];
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else opts.name = a;
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

  // generate() and formatAll() are synchronous — do not await them.
  const files = formatAll(generate(spec));
  const outDir = opts.outDir ?? join("packages", "mcp-connectors", spec.name);

  if (opts.dryRun) {
    console.log(`Would write ${files.length} files to ${outDir}/\n`);
    console.log(renderTree(files));
    return;
  }

  await writeFiles(files, outDir);
  console.log(`Created ${outDir}/ (${files.length} files)`);
}

// Guarded so Task 18's scripts/acceptance.ts can import writeFiles without side effects.
if (import.meta.main) {
  await main(process.argv.slice(2));
}
