import { takeValue } from "../../src/cli.ts";
import type { ConnectorResult, Tier } from "./reach.ts";

export type Baseline = { connectorsTree: string; tiers: Record<string, Tier> };

/**
 * `bun run reach:baseline`'s own argument parsing, lifted out of scripts/reach-baseline.ts on
 * the same scripts/_lib/golden-diff.ts precedent scripts/_lib/reach.ts's `parseArgs` cites:
 * `main()` there needs a Nimbus checkout and cannot clear the per-file coverage floor, so a
 * test reaching for `parseArgs` alone must not drag it in.
 *
 * This command always measures and records the FULL corpus — that is its entire point, and
 * `--baseline`/connector names on `bun run reach` exist precisely to compare a run against what
 * this one wrote. There is no scoped-baseline format this command could honor, so an
 * unsupported flag or a positional name is refused rather than ignored.
 */
export function parseArgs(argv: readonly string[]): { nimbusRoot?: string } {
  let nimbusRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--nimbus-root") {
      nimbusRoot = takeValue(argv, ++i, "--nimbus-root");
    } else {
      throw new Error(
        `reach:baseline accepts only --nimbus-root; got "${a}". It always measures and records ` +
          "the full corpus — there is no flag to scope it to a subset of connectors. " +
          "`bun run reach --baseline` compares the full corpus against the recorded baseline; " +
          "use `bun run reach <connector>` to measure a subset instead.",
      );
    }
  }
  return { nimbusRoot };
}

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

/**
 * Whether `--baseline` may run given the connector names on the command line.
 *
 * `--baseline` compares the FULL corpus against fixtures/reach-baseline.json. `compareBaseline`
 * treats every baseline connector absent from the CURRENT run as having regressed to "blocked"
 * (see its `now.get(name) ?? "blocked"` below) — correct when a run is short a connector because
 * something crashed, wrong when it is short 93 connectors because the caller only asked to
 * measure one. `bun run reach --baseline newrelic` would report 93 invented regressions from a
 * perfectly legal, narrower invocation. There is no scoped-baseline format to invent that would
 * make "regressed" mean the same thing across both call shapes, so this refuses rather than
 * approximating one.
 */
export function baselineScopeRefusal(
  names: readonly string[],
  baseline: boolean,
): string | undefined {
  if (!baseline || names.length === 0) return undefined;
  return (
    "--baseline compares the full corpus against fixtures/reach-baseline.json; combining it " +
    `with connector name(s) (${names.join(", ")}) would read every OTHER baselined connector ` +
    'as having regressed to "blocked". Run --baseline alone against the full corpus, or drop ' +
    "--baseline to measure just those connector(s)."
  );
}

/**
 * Whether the connectors-tree lookup (`git rev-parse HEAD:packages/mcp-connectors`) itself
 * succeeded — checked separately from `assertComparable`'s `gitError`, which only covers the
 * commands run BEFORE deciding a checkout is comparable at all. This is one step later: the
 * command that supplies the actual baseline key. Swallowing its error the same way `head.error`
 * used to be swallowed turns a failed lookup into the tree key `""`, which reach-baseline.ts
 * would then happily WRITE as the baseline's connectorsTree and reach.ts would then happily
 * COMPARE against — an empty string is a valid-looking key, not a visible failure.
 */
export function connectorsTreeRefusal(error: string): string | undefined {
  if (error === "") return undefined;
  return (
    `git could not read the tree object of packages/mcp-connectors: ${error}. A baseline is ` +
    "keyed on that tree, so it can be neither recorded nor compared without it."
  );
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
