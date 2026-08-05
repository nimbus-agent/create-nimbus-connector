import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Blocker } from "./blockers.ts";
import { deriveSpec } from "./index.ts";

export type FromConnectorResult =
  | {
      ok: true;
      spec: Record<string, unknown>;
      target: "monorepo" | "standalone";
      /** Things the user must verify by hand — e.g. an ambiguous `effect` attribution. */
      notes: readonly string[];
    }
  | { ok: false; blockers: readonly Blocker[] };

/** A missing input is a blocker like any other, so one report shape covers every failure. */
function missing(path: string): Blocker {
  return { kind: `missing-file:${path}`, detail: `${path} was not found`, line: 0 };
}

/**
 * The note shown for one effect assigned to more than one tool. A named top-level function
 * rather than an inline `.map()` callback so it can be unit-tested directly: no fixture in
 * this repo's corpus currently derives with an ambiguous effect (every write-shaped tool in
 * fixtures/ blocks on the "write body" gap tracked in test/derive/round-trip.test.ts before
 * attributeEffects ever runs), so an inline lambda here would be an uncalled function on every
 * real run this repo can currently exercise.
 */
export function ambiguityNote(effect: string): string {
  return (
    `more than one tool was assigned effect "${effect}". The emitted manifest is correct ` +
    "either way, but at most one of them may actually be one — confirm each before generating."
  );
}

/**
 * `ConnectorSpecSchema` is a z.strictObject, so a top-level key it does not define is a hard
 * rejection — a partial draft carrying this key cannot be generated until a human deletes it.
 * The rejection is structural rather than a convention someone could forget to check: a
 * partial spec that DID validate would silently emit a connector missing tools, which is the
 * accepted-then-discarded failure this repo has already removed twice (src/spec.ts's
 * omitWhen and search/query refinements narrate both).
 */
export const PARTIAL_MARKER = "$partial";

export async function deriveFromDirectory(
  dir: string,
  options: { partial?: boolean } = {},
): Promise<FromConnectorResult> {
  const serverPath = join(dir, "src", "server.ts");
  const manifestPath = join(dir, "nimbus.extension.json");
  const absent = [
    ...(existsSync(serverPath) ? [] : [missing("src/server.ts")]),
    ...(existsSync(manifestPath) ? [] : [missing("nimbus.extension.json")]),
  ];
  if (absent.length > 0) return { ok: false, blockers: absent };

  const server = await Bun.file(serverPath).text();
  const manifest = await Bun.file(manifestPath).text();
  // The target is a generate() option rather than a spec field, so it is reported separately.
  const target = server.includes("@nimbus-dev/sdk/connector-kit") ? "standalone" : "monorepo";

  const derivation = deriveSpec({ server, manifest });
  if (!derivation.ok) {
    if (options.partial !== true) return { ok: false, blockers: derivation.blockers };
    return {
      ok: true,
      target,
      notes: ["this spec is PARTIAL and will not validate until the marker key is resolved."],
      spec: {
        [PARTIAL_MARKER]: {
          note: "Derived partially. Resolve each blocker, then delete this key.",
          blockers: derivation.blockers.map((b) => b.kind),
        },
      },
    };
  }
  // Task 5 attaches the ambiguity as a SIBLING on Derivation, never inside `spec` — so there is
  // nothing to strip. That placement is forced, not stylistic: ConnectorSpecSchema is a
  // z.strictObject, and scripts/_lib/reach.ts and test/derive/round-trip.test.ts both call
  // parseSpec(derivation.spec) unconditionally, so a key nested inside `spec` would throw on
  // every ambiguous derivation. It is absent entirely when there is no ambiguity.
  const ambiguous = derivation.$effectAmbiguity ?? [];
  return {
    ok: true,
    spec: derivation.spec,
    target,
    notes: ambiguous.map(ambiguityNote),
  };
}

/**
 * `blocked` is a RESULT, not an error. The user learns which construct stopped the read, in the
 * same vocabulary `bun run reach --verbose` prints — which is also the report that says which
 * recognizer to write next.
 */
export function renderBlockers(dir: string, blockers: readonly Blocker[]): string {
  const lines = blockers.map((b) => `  ${b.kind}${b.line > 0 ? `  (line ${b.line})` : ""}`);
  return (
    `cannot read ${dir} into a spec. What stopped it:\n\n` +
    `${lines.join("\n")}\n\n` +
    "Each label names a construct this generator's spec language does not model. See\n" +
    "docs/ROADMAP.md's Known limitations for the ones that are permanent."
  );
}
