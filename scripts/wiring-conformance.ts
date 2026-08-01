/**
 * Checks the emitted Gateway wiring skeleton against Nimbus's REAL sync interface.
 *
 * Why this exists as a separate, deliberately-run script rather than a test: like
 * `diff:golden`, it needs a checkout of the Nimbus monorepo, which is a separate
 * AGPL-3.0-only repository that CI does not have. A test that silently skipped when the
 * root is absent would be green in CI while asserting nothing — the exact failure mode this
 * project keeps removing — so it is a script you run before merging a wiring change.
 *
 * What it covers that `test/emit/emitted-typecheck.test.ts` cannot. That test compiles the
 * emitted pair against a stand-in written HERE, because this repo is MIT and Nimbus is
 * AGPL-3.0-only, so the real file cannot be vendored. A locally-written stand-in proves the
 * skeleton is internally well-typed, and proves nothing at all about whether it still
 * matches Nimbus. That is not hypothetical: the stand-in shipped with `upserted`/`deleted`
 * while the real `SyncResult` spells them `itemsUpserted`/`itemsDeleted`.
 *
 * So this script reads the real interface and asserts two things:
 *
 *   1. The emitted skeleton supplies every member `Syncable` requires. If Nimbus adds a
 *      required member, every connector this generator wires stops compiling, and the first
 *      person to find out should not be a user.
 *   2. The stand-in in emitted-typecheck.test.ts agrees with the real member names. This is
 *      what converts that stand-in from an invention into a checked approximation.
 *
 * It reads Nimbus and writes nothing to it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { takeValue } from "../src/cli.ts";
import { emitWiring } from "../src/emit/wiring.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import { parseSpec } from "../src/spec.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

export function parseArgs(argv: readonly string[]): { nimbusRoot?: string } {
  let nimbusRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--nimbus-root") {
      nimbusRoot = takeValue(argv, ++i, "--nimbus-root");
    } else {
      throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  return { nimbusRoot };
}

/**
 * Member names of a `interface X { ... }` block, by brace matching from its opening brace.
 *
 * Regex rather than a TypeScript parser because the shape being read is one flat interface
 * of scalar members, and the failure mode of getting it wrong is loud: an empty member set
 * fails the "found nothing" check below rather than passing vacuously.
 */
export function interfaceMembers(source: string, name: string): string[] {
  const start = source.indexOf(`interface ${name} {`);
  if (start === -1) throw new Error(`interface ${name} not found in the real sync/types.ts`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(open + 1, end);
  // `name:` / `name?:` / `name(` at the start of a line, ignoring comments and nesting.
  //
  // The tail is spelled `\s*(?:\?\s*)?` and not `\s*\??\s*`. The two describe the same
  // language — optional whitespace, an optional `?`, optional whitespace — but the second
  // is ambiguous: a run of n spaces before a non-`?` can be split between the two `\s*`
  // in n+1 ways, which is polynomial backtracking on a failing line. Separating the two
  // quantifiers with the mandatory `\?` leaves exactly one parse for any input.
  return [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*(?:\?\s*)?[:(]/gm)].map(
    (m) => m[1]!,
  );
}

function main(argv: readonly string[]): void {
  const { nimbusRoot } = parseArgs(argv);
  const root = resolveNimbusRoot({
    flag: nimbusRoot,
    env: process.env["NIMBUS_ROOT"],
    scriptDir,
  });
  const typesPath = join(root, "packages", "gateway", "src", "sync", "types.ts");
  const real = readFileSync(typesPath, "utf8");

  const required = interfaceMembers(real, "Syncable");
  const resultMembers = interfaceMembers(real, "SyncResult");
  if (required.length === 0 || resultMembers.length === 0) {
    throw new Error(`Parsed no members out of ${typesPath} — the interface shape has changed.`);
  }

  const spec = parseSpec(
    JSON.parse(readFileSync(join(repoRoot, "fixtures", "zzscratch.spec.json"), "utf8")),
  );
  const emitted = emitWiring(spec);
  const syncFile = emitted.find((f) => f.path.at(-1)?.endsWith("-sync.ts"));
  if (syncFile === undefined) throw new Error("emitWiring produced no *-sync.ts file");

  const failures: string[] = [];

  // 1. Every required Syncable member must be supplied by the emitted object literal.
  for (const member of required) {
    const supplies = new RegExp(String.raw`\b${member}\s*[:(]`).test(syncFile.content);
    if (!supplies) failures.push(`emitted skeleton does not supply Syncable.${member}`);
  }

  // 2. The stand-in must agree with the real names, or the typecheck test is checking a
  //    shape Nimbus does not have.
  // Scoped to the template literal, NOT the whole file. Searching the file passes vacuously:
  // that test's own docstring discusses the real member names in prose, so `itemsUpserted`
  // is present as English whether or not the stand-in type declares it. Caught by reverting
  // the stand-in to its shipped `upserted`/`deleted` and watching this check stay green.
  const standinFile = readFileSync(
    join(repoRoot, "test", "emit", "emitted-typecheck.test.ts"),
    "utf8",
  );
  const open = standinFile.indexOf("SYNC_TYPES_STANDIN = `");
  if (open === -1) throw new Error("SYNC_TYPES_STANDIN not found in emitted-typecheck.test.ts");
  const bodyStart = standinFile.indexOf("`", open) + 1;
  const bodyEnd = standinFile.indexOf("`", bodyStart);
  const standin = standinFile.slice(bodyStart, bodyEnd);
  if (standin.trim() === "") throw new Error("SYNC_TYPES_STANDIN parsed as empty");

  for (const member of resultMembers) {
    // bytesTransferred is optional in the real interface; the stand-in need not carry it.
    if (member === "bytesTransferred") continue;
    if (!standin.includes(member)) {
      failures.push(
        `SYNC_TYPES_STANDIN is missing SyncResult.${member} — the stand-in has drifted ` +
          `from ${typesPath}, so emitted-typecheck.test.ts is compiling against a shape ` +
          `Nimbus does not have.`,
      );
    }
  }

  console.log(`Syncable requires: ${required.join(", ")}`);
  console.log(`SyncResult fields:  ${resultMembers.join(", ")}`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL  ${f}`);
    throw new Error(`${failures.length} wiring conformance failure(s).`);
  }
  console.log(`\nPASS  emitted wiring conforms to ${typesPath}`);
}

// Guarded exactly as src/cli.ts is: importing this module used to demand a Nimbus checkout
// and throw without one, so neither helper above could be reached from a test.
// `bun scripts/wiring-conformance.ts` is unchanged.
if (import.meta.main) {
  main(process.argv.slice(2));
}
