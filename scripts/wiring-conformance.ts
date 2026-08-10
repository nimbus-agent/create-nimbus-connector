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
import { checkWiring, optionalReport } from "./_lib/wiring-checks.ts";

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

function main(argv: readonly string[]): void {
  const { nimbusRoot } = parseArgs(argv);
  const root = resolveNimbusRoot({
    flag: nimbusRoot,
    env: process.env["NIMBUS_ROOT"],
    scriptDir,
  });
  const typesPath = join(root, "packages", "gateway", "src", "sync", "types.ts");
  const real = readFileSync(typesPath, "utf8");

  const spec = parseSpec(
    JSON.parse(readFileSync(join(repoRoot, "fixtures", "zzscratch.spec.json"), "utf8")),
  );
  const emitted = emitWiring(spec);
  const syncFile = emitted.find((f) => f.path.at(-1)?.endsWith("-sync.ts"));
  if (syncFile === undefined) throw new Error("emitWiring produced no *-sync.ts file");

  // The stand-in is read from its TEMPLATE LITERAL, not the whole file. Searching the file
  // passes vacuously: that test's own docstring discusses the real member names in prose, so
  // `itemsUpserted` is present as English whether or not the stand-in type declares it. Caught
  // by reverting the stand-in to its shipped `upserted`/`deleted` and watching it stay green.
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

  const verdict = checkWiring({
    realTypes: real,
    emittedSync: syncFile.content,
    standin,
    typesPath,
  });

  console.log(`Syncable requires: ${verdict.required.join(", ")}`);
  console.log(`SyncResult fields:  ${verdict.resultRequired.join(", ")}`);
  const optional = optionalReport(verdict);
  if (optional.length > 0) {
    console.log(`Optional, not required of the skeleton: ${optional.join(", ")}`);
  }
  if (verdict.failures.length > 0) {
    for (const f of verdict.failures) console.error(`FAIL  ${f}`);
    throw new Error(`${verdict.failures.length} wiring conformance failure(s).`);
  }
  console.log(`\nPASS  emitted wiring conforms to ${typesPath}`);
}

// Guarded exactly as src/cli.ts is: importing this module used to demand a Nimbus checkout
// and throw without one, so neither helper above could be reached from a test.
// `bun scripts/wiring-conformance.ts` is unchanged.
if (import.meta.main) {
  main(process.argv.slice(2));
}
