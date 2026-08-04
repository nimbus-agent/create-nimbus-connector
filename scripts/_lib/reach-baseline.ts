import type { ConnectorResult, Tier } from "./reach.ts";

export type Baseline = { connectorsTree: string; tiers: Record<string, Tier> };

const RANK: Tier[] = ["blocked", "emits", "server-identical", "all-identical"];

export function buildBaseline(
  connectorsTree: string,
  results: readonly ConnectorResult[],
): Baseline {
  const tiers: Record<string, Tier> = {};
  for (const r of results) tiers[r.name] = r.tier;
  return { connectorsTree, tiers };
}

/**
 * Whether this checkout may be baselined or compared at all.
 *
 * A dirty tree is refused for the same reason a cross-tree comparison is: the baseline is keyed
 * on the tree object of packages/mcp-connectors — the only path this harness reads — and filing
 * measurements of bytes that differ from that tree produces a false green WITH a paper trail,
 * which is worse than no record. Keying on that tree rather than on HEAD is deliberate: two
 * commits can carry byte-identical packages/mcp-connectors (a change elsewhere in the monorepo,
 * a merge, a revert), and refusing on a commit SHA that moved while the tree did not made
 * `--baseline` refuse a corpus that had not actually changed.
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
    return `git could not run against the Nimbus root: ${args.gitError}. A baseline needs git to name the tree it measured; the plain report still works without --baseline.`;
  }
  if (args.commit === "") {
    return "The Nimbus root is not a git checkout, so a baseline cannot name what it measured. The plain report still works without --baseline.";
  }
  if (args.dirty) {
    return "The Nimbus checkout is dirty under packages/mcp-connectors, so its tree does not describe the bytes being measured. Commit or stash there, or run without --baseline.";
  }
  return undefined;
}

export function compareBaseline(
  baseline: Baseline,
  results: readonly ConnectorResult[],
  connectorsTree: string,
): { refusal?: string; regressions: { name: string; from: Tier; to: Tier }[] } {
  if (baseline.connectorsTree !== connectorsTree) {
    return {
      refusal:
        `The baseline was measured against connectorsTree ${baseline.connectorsTree} and this ` +
        `checkout's packages/mcp-connectors tree is ${connectorsTree}. Comparing across trees ` +
        "would produce a verdict spanning two different corpora. Check out the baseline's " +
        "revision, or re-baseline with `bun run reach:baseline`.",
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
