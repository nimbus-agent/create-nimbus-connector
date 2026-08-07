import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseSpec } from "../spec.ts";
import { validateSpec } from "../validate.ts";
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

/**
 * The `--partial` shape, shared by both failure sources below (a `deriveSpec` blocker and a
 * post-derivation validation rejection) so a caller sees one draft format regardless of which
 * stage produced it.
 */
function partialResult(
  target: "monorepo" | "standalone",
  blockers: readonly Blocker[],
): FromConnectorResult {
  return {
    ok: true,
    target,
    notes: ["this spec is PARTIAL and will not validate until the marker key is resolved."],
    spec: {
      [PARTIAL_MARKER]: {
        note: "Derived partially. Resolve each blocker, then delete this key.",
        blockers: blockers.map((b) => b.kind),
      },
    },
  };
}

/**
 * `deriveSpec`'s own `ok: true` means every AST construct in `src/server.ts` was recognized — it
 * says nothing about whether the RECOVERED spec is one this generator can actually regenerate.
 * scripts/_lib/reach.ts's `measure()` treats `parseSpec` + `validateSpec` as the real `emits`-tier
 * boundary: a spec that trips `RESERVED_IDENTIFIERS` (e.g. a hand-authored connector whose fetch
 * helper happens to be named "token", one of ~30 reserved names) is `rejected-by-validate` there,
 * not success. `deriveFromDirectory` used to skip that boundary entirely and report success —
 * exit 0, spec on stdout — for a spec `--spec` would then refuse outright. Same blocker `kind` as
 * `reach` uses, so this is one vocabulary, not a second shape invented for the same failure.
 */
function rejectedByValidate(spec: Record<string, unknown>): Blocker | undefined {
  try {
    validateSpec(parseSpec(spec));
    return undefined;
  } catch (err) {
    return {
      kind: "rejected-by-validate",
      detail: err instanceof Error ? err.message : String(err),
      line: 0,
    };
  }
}

export async function deriveFromDirectory(
  dir: string,
  options: { partial?: boolean } = {},
): Promise<FromConnectorResult> {
  const serverPath = join(dir, "src", "server.ts");
  const manifestPath = join(dir, "nimbus.extension.json");
  const filterPath = join(dir, "src", "search-filter.ts");
  const absent = [
    ...(existsSync(serverPath) ? [] : [missing("src/server.ts")]),
    ...(existsSync(manifestPath) ? [] : [missing("nimbus.extension.json")]),
  ];
  if (absent.length > 0) return { ok: false, blockers: absent };

  const server = await Bun.file(serverPath).text();
  const manifest = await Bun.file(manifestPath).text();
  // Optional, unlike the two above: a connector with no search tool never has this file, and
  // that is not by itself a blocker — deriveSpec is what decides whether its absence matters
  // (a recognized search tool with no filter file IS one; see deriveSharedStyleSpec).
  const filter = existsSync(filterPath) ? await Bun.file(filterPath).text() : undefined;
  // The target is a generate() option rather than a spec field, so it is reported separately.
  const target = server.includes("@nimbus-dev/sdk/connector-kit") ? "standalone" : "monorepo";

  const derivation = deriveSpec({ server, manifest, filter });
  if (!derivation.ok) {
    if (options.partial !== true) return { ok: false, blockers: derivation.blockers };
    return partialResult(target, derivation.blockers);
  }

  const rejection = rejectedByValidate(derivation.spec);
  if (rejection !== undefined) {
    if (options.partial !== true) return { ok: false, blockers: [rejection] };
    return partialResult(target, [rejection]);
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
  const lines = blockers.map((b) => {
    const where = b.line > 0 ? `  (line ${b.line})` : "";
    return `  ${b.kind}${where}`;
  });
  return (
    `cannot read ${dir} into a spec. What stopped it:\n\n` +
    `${lines.join("\n")}\n\n` +
    "Each label names a construct this generator's spec language does not model. See\n" +
    "docs/ROADMAP.md's Known limitations for the ones that are permanent."
  );
}
