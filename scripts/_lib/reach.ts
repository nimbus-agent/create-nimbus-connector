import { displayPath, type GeneratedFile } from "../../src/types.ts";
import type { Blocker } from "./derive/blockers.ts";
import type { Derivation } from "./derive/index.ts";

export type Tier = "blocked" | "emits" | "server-identical" | "all-identical";

export type ConnectorResult = { name: string; tier: Tier; blockers: Blocker[] };

const SERVER = "src/server.ts";

/**
 * Tiers are cumulative: all-identical implies server-identical implies emits.
 *
 * A generated file with no counterpart upstream counts as a mismatch, not as a pass — 15 of the
 * 94 connectors carry no test/sandbox.test.ts, and treating a missing file as agreement would
 * report those as all-identical on the strength of a file that is not there.
 */
export function tierFor(args: {
  derivation: Derivation;
  generated?: readonly GeneratedFile[];
  real?: ReadonlyMap<string, string>;
}): Tier {
  if (!args.derivation.ok) return "blocked";
  const { generated, real } = args;
  if (generated === undefined || real === undefined) return "emits";

  const matches = (path: string): boolean => {
    const file = generated.find((f) => displayPath(f.path) === path);
    return file !== undefined && real.get(path) === file.content;
  };

  if (!matches(SERVER)) return "emits";
  return generated.every((f) => matches(displayPath(f.path)))
    ? "all-identical"
    : "server-identical";
}

/** Blocker buckets, most common first, counting each connector once per distinct kind. */
export function histogram(
  results: readonly ConnectorResult[],
): { kind: string; count: number; examples: string[] }[] {
  const byKind = new Map<string, string[]>();
  for (const result of results) {
    for (const kind of new Set(result.blockers.map((b) => b.kind))) {
      byKind.set(kind, [...(byKind.get(kind) ?? []), result.name]);
    }
  }
  return [...byKind.entries()]
    .map(([kind, examples]) => ({ kind, count: examples.length, examples }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

const ORDER: Tier[] = ["emits", "server-identical", "all-identical"];

function atLeast(results: readonly ConnectorResult[], tier: Tier): number {
  const floor = ORDER.indexOf(tier);
  return results.filter((r) => ORDER.indexOf(r.tier) >= floor).length;
}

/**
 * The connectors to measure, refusing the one way this harness could report a vacuous pass.
 *
 * Mirrors selectFixtures in scripts/_lib/golden-diff.ts: an empty measurement set must never
 * produce a number, because "0 of 0" reads as a result rather than as an empty run.
 */
export function selectConnectors(names: readonly string[], all: readonly string[]): string[] {
  const selected = names.length > 0 ? [...names] : [...all];
  if (selected.length === 0) {
    throw new Error(
      "No connectors found under packages/mcp-connectors. Refusing to report a reach number " +
        "with nothing measured.",
    );
  }
  return selected;
}

export function summaryLines(results: readonly ConnectorResult[]): string[] {
  const total = results.length;
  return [
    `REACH  ${atLeast(results, "server-identical")}/${total}  (server.ts byte-identical)`,
    "",
    `  spec derived + emits   ${atLeast(results, "emits")}/${total}`,
    `  server.ts identical    ${atLeast(results, "server-identical")}/${total}   <- headline`,
    `  all files identical    ${atLeast(results, "all-identical")}/${total}`,
  ];
}
