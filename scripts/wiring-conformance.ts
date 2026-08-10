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
import { type InterfaceMember, interfaceMemberDetails } from "./_lib/interface-members.ts";
import { objectLiteralKeys } from "./_lib/object-literal-keys.ts";

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

  const syncable = interfaceMemberDetails(real, "Syncable");
  const result = interfaceMemberDetails(real, "SyncResult");
  // Vacuity guard on the PARSED set, not on the required subset: an interface whose members
  // were all optional would otherwise report "parsed nothing" and mask a real parse failure
  // behind a plausible-looking message.
  if (syncable.length === 0 || result.length === 0) {
    throw new Error(`Parsed no members out of ${typesPath} — the interface shape has changed.`);
  }

  const names = (ms: readonly InterfaceMember[]): string[] => ms.map((m) => m.name);
  const required = names(syncable.filter((m) => !m.optional));
  const optional = names(syncable.filter((m) => m.optional));
  const resultMembers = names(result.filter((m) => !m.optional));
  const resultOptional = names(result.filter((m) => m.optional));

  const spec = parseSpec(
    JSON.parse(readFileSync(join(repoRoot, "fixtures", "zzscratch.spec.json"), "utf8")),
  );
  const emitted = emitWiring(spec);
  const syncFile = emitted.find((f) => f.path.at(-1)?.endsWith("-sync.ts"));
  if (syncFile === undefined) throw new Error("emitWiring produced no *-sync.ts file");

  const failures: string[] = [];

  // 1. Every required Syncable member must be supplied by the emitted object literal.
  //
  // Scoped to the literal, NOT the whole file — for the same reason check 2 below is scoped to
  // the template literal, which is a lesson this check had to learn twice. Searching the file
  // passed vacuously: the emitted docstring says "sync() below throws", so `\bsync\s*[:(]`
  // matched as ENGLISH whether or not the skeleton declared the method. Caught by renaming the
  // emitted `sync` to `syncMUTANT` and watching this check stay green.
  const supplied = new Set(objectLiteralKeys(syncFile.content, "return {"));
  for (const member of required) {
    if (!supplied.has(member)) failures.push(`emitted skeleton does not supply Syncable.${member}`);
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

  // Required members only. The stand-in need not carry an optional field — this used to be a
  // hard-coded `bytesTransferred` skip, which is the same rule written once per name.
  for (const member of resultMembers) {
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

  // Optional members are reported, never failed on. Reported because the choice not to supply
  // one is a real product decision that should be made deliberately rather than by silence:
  // `Syncable.fetchOne` is optional precisely so a connector may omit it, and Nimbus answers
  // `no_targeted_fetch` for one that does. Whether generated connectors should start supplying
  // it is a question for a human reading this line, not something this gate can decide.
  const optionalReport = [
    ...optional.map((m) => `Syncable.${m}`),
    ...resultOptional.map((m) => `SyncResult.${m}`),
  ];
  if (optionalReport.length > 0) {
    console.log(`Optional, not required of the skeleton: ${optionalReport.join(", ")}`);
  }
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
