/**
 * The two conformance checks behind `bun run wiring:conformance`, as a pure function.
 *
 * Split from the script for the reason its `_lib` siblings are: the script itself cannot run
 * without an AGPL Nimbus checkout, so every line left inside it is a line no CI run can cover.
 * The checks take three STRINGS and return a verdict — the file reading, path resolution and
 * printing stay in the script, and everything that can be wrong about the comparison is
 * exercised here.
 *
 * That split is not only a coverage device. Both checks have been vacuous in production, and
 * neither failure was reachable by a test while the logic lived inside a script nothing could
 * call: the stand-in once shipped `upserted`/`deleted` against a real `itemsUpserted`, and the
 * skeleton check matched the emitted file's own docstring rather than its object literal. The
 * unit tests beside this file pin both, including the mutation that exposed the second.
 */

import { type InterfaceMember, interfaceMemberDetails } from "./interface-members.ts";
import { objectLiteralKeys } from "./object-literal-keys.ts";

export interface WiringVerdict {
  /** `Syncable` members a conforming skeleton MUST supply. */
  readonly required: readonly string[];
  /** `Syncable` members it may omit — reported to a human, never failed on. */
  readonly optional: readonly string[];
  /** `SyncResult` fields the stand-in must declare. */
  readonly resultRequired: readonly string[];
  /** `SyncResult` fields it need not declare. */
  readonly resultOptional: readonly string[];
  /** Empty when the wiring conforms. */
  readonly failures: readonly string[];
}

export interface WiringInputs {
  /** Nimbus's real `sync/types.ts`. */
  readonly realTypes: string;
  /** The emitted `*-sync.ts`. */
  readonly emittedSync: string;
  /** The body of `SYNC_TYPES_STANDIN` from emitted-typecheck.test.ts. */
  readonly standin: string;
  /** Only used to make the failure message name the file a reader should open. */
  readonly typesPath: string;
}

const names = (ms: readonly InterfaceMember[]): string[] => ms.map((m) => m.name);

export function checkWiring(inputs: WiringInputs): WiringVerdict {
  const syncable = interfaceMemberDetails(inputs.realTypes, "Syncable");
  const result = interfaceMemberDetails(inputs.realTypes, "SyncResult");

  // Vacuity guard on the PARSED set, not on the required subset: an interface whose members
  // were all optional would otherwise report "parsed nothing" and mask a real parse failure
  // behind a plausible-looking message.
  if (syncable.length === 0 || result.length === 0) {
    throw new Error(
      `Parsed no members out of ${inputs.typesPath} — the interface shape has changed.`,
    );
  }

  const required = names(syncable.filter((m) => !m.optional));
  const optional = names(syncable.filter((m) => m.optional));
  const resultRequired = names(result.filter((m) => !m.optional));
  const resultOptional = names(result.filter((m) => m.optional));

  const failures: string[] = [];

  // 1. Every required Syncable member must be supplied by the emitted OBJECT LITERAL.
  //
  // Scoped to the literal, not the whole file — a lesson this check had to learn twice. The
  // earlier form asked whether the file matched `\bsync\s*[:(]`, and the emitted docstring says
  // "sync() below throws", so it matched as ENGLISH whether or not the skeleton declared the
  // method. Renaming the emitted method to `syncMUTANT` left the gate green.
  const supplied = new Set(objectLiteralKeys(inputs.emittedSync, "return {"));
  for (const member of required) {
    if (!supplied.has(member)) failures.push(`emitted skeleton does not supply Syncable.${member}`);
  }

  // 2. The stand-in must agree with the real names, or emitted-typecheck.test.ts is compiling
  //    against a shape Nimbus does not have.
  //
  // Required fields only. The stand-in need not carry an optional one — which used to be a
  // hard-coded `bytesTransferred` skip, i.e. this rule written once per name.
  for (const member of resultRequired) {
    if (!inputs.standin.includes(member)) {
      failures.push(
        `SYNC_TYPES_STANDIN is missing SyncResult.${member} — the stand-in has drifted ` +
          `from ${inputs.typesPath}, so emitted-typecheck.test.ts is compiling against a shape ` +
          `Nimbus does not have.`,
      );
    }
  }

  return { required, optional, resultRequired, resultOptional, failures };
}

/**
 * The optional members, formatted for the one line the script prints about them.
 *
 * Reported rather than silent because the choice not to supply one is a real product decision:
 * `Syncable.fetchOne` is optional precisely so a connector may omit it, and Nimbus answers
 * `no_targeted_fetch` for one that does. Whether generated connectors should start supplying it
 * is a question for a human reading this line, not something a gate can decide.
 */
export function optionalReport(verdict: WiringVerdict): string[] {
  return [
    ...verdict.optional.map((m) => `Syncable.${m}`),
    ...verdict.resultOptional.map((m) => `SyncResult.${m}`),
  ];
}
