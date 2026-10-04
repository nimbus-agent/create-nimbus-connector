#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CliOptions, parseCliArgs } from "./cli-args.ts";
import { generate } from "./emit/index.ts";
import { emitWiring, renderWiringInstructions } from "./emit/wiring.ts";
import {
  formatAll,
  formatterAvailable,
  formatterUnavailableReason,
  initFormatter,
} from "./format.ts";
import { MARKER } from "./golden/resolve.ts";
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

/**
 * Exported for scripts/acceptance.ts (Task 18) — must stay side-effect-free besides disk I/O.
 *
 * One file at a time, never Promise.all. A failed write stops the loop before the next file is
 * started, so a run that fails leaves every file before it whole and none after it begun.
 * Promise.all would leave the other writes in flight after the first rejection, and main()'s
 * `process.exit(1)` does not wait for them: it can end the process part-way through a file — one
 * that may sit in someone else's checkout, under --gateway-wiring.
 */
export async function writeFiles(files: readonly GeneratedFile[], outDir: string): Promise<void> {
  for (const f of files) {
    const target = join(outDir, ...f.path);
    await mkdir(dirname(target), { recursive: true }); // NOSONAR S9382: fail-fast — nothing after a failed write may start
    await writeFile(target, f.content, "utf8"); // NOSONAR S9382: fail-fast — process.exit(1) must not cut a write short
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
 * That limit is stated in the schema document's own `description`, in docs/SPEC-RULES.md's
 * *Editor support* section (README.md's until the spec prose moved out of it) and in ROADMAP, and
 * all three require the reader to already be looking. This is where they are not: they are looking
 * at a CLI that just refused a file their editor called clean, and nothing in `parseSpec`'s message
 * mentions a schema at all.
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
        "so an editor can call this file valid while this command refuses it. See " +
        '"Editor support: the published JSON Schema, and what it cannot check" in ' +
        "docs/SPEC-RULES.md.",
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
