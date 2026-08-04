import type { ConnectorResult, Tier } from "./reach.ts";

export type Baseline = { nimbusCommit: string; tiers: Record<string, Tier> };

const RANK: Tier[] = ["blocked", "emits", "server-identical", "all-identical"];

export function buildBaseline(commit: string, results: readonly ConnectorResult[]): Baseline {
  const tiers: Record<string, Tier> = {};
  for (const r of results) tiers[r.name] = r.tier;
  return { nimbusCommit: commit, tiers };
}

/**
 * Whether this checkout may be baselined or compared at all.
 *
 * A dirty tree is refused for the same reason a cross-revision comparison is: a commit SHA
 * describes a tree, and filing measurements of bytes that differ from it produces a false green
 * WITH a paper trail, which is worse than no record. The caller scopes its dirtiness check to
 * packages/mcp-connectors — the only tree this harness reads — so unrelated work elsewhere in
 * the monorepo does not make the gate something to work around.
 */
export function assertComparable(args: {
  commit: string;
  dirty: boolean;
  gitError?: string;
}): string | undefined {
  // Distinguished from "not a git checkout" because the two send a developer to different
  // problems: one is fixed by installing git, the other by pointing --nimbus-root somewhere
  // else. A single message covering both would be wrong half the time.
  if (args.gitError !== undefined && args.gitError !== "") {
    return `git could not run against the Nimbus root: ${args.gitError}. A baseline needs git to name the commit it measured; the plain report still works without --baseline.`;
  }
  if (args.commit === "") {
    return "The Nimbus root is not a git checkout, so a baseline cannot name what it measured. The plain report still works without --baseline.";
  }
  if (args.dirty) {
    return "The Nimbus checkout is dirty under packages/mcp-connectors, so its commit does not describe the bytes being measured. Commit or stash there, or run without --baseline.";
  }
  return undefined;
}

export function compareBaseline(
  baseline: Baseline,
  results: readonly ConnectorResult[],
  commit: string,
): { refusal?: string; regressions: { name: string; from: Tier; to: Tier }[] } {
  if (baseline.nimbusCommit !== commit) {
    return {
      refusal:
        `The baseline was measured at Nimbus ${baseline.nimbusCommit} and this checkout is at ` +
        `${commit}. Comparing across revisions would produce a verdict spanning two corpora. ` +
        "Check out that revision, or re-baseline with `bun run reach:baseline`.",
      regressions: [],
    };
  }

  const now = new Map(results.map((r) => [r.name, r.tier]));
  const regressions: { name: string; from: Tier; to: Tier }[] = [];
  for (const [name, from] of Object.entries(baseline.tiers)) {
    const to = now.get(name) ?? "blocked";
    if (RANK.indexOf(to) < RANK.indexOf(from)) regressions.push({ name, from, to });
  }
  return { regressions };
}
