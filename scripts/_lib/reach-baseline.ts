import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { takeValue } from "../../src/cli.ts";
import { initParser, parserAvailable, parserUnavailableReason } from "../../src/derive/ast.ts";
import { formatterAvailable, formatterUnavailableReason, initFormatter } from "../../src/format.ts";
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

/**
 * The recorded baseline's path — the one definition.
 *
 * `scripts/reach.ts` and `scripts/reach-baseline.ts` each computed this identically, which is
 * a shape this pair specifically must not have: one writes the file and the other reads it,
 * so two definitions of where it lives is a way for the writer and the reader to disagree
 * about which file the gate is even about. The `..` count differs from theirs because this
 * module sits one directory deeper.
 */
export const BASELINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "reach-baseline.json",
);

/**
 * Bring up Biome and Babel, or refuse with the reason.
 *
 * Both harnesses need both, for reasons that are not interchangeable: without the formatter a
 * byte-comparison reports spurious diffs that read as reach regressions, and without the parser
 * every connector derives as `blocked:parse-error` — which on the recording side would silently
 * write a false corpus-wide zero as the baseline, and every later run would compare green
 * against it forever. The two copies of these guards were identical down to the error strings.
 */
export type DeriveToolchain = {
  initFormatter: () => Promise<unknown>;
  formatterAvailable: () => boolean;
  formatterUnavailableReason: () => string | undefined;
  initParser: () => Promise<unknown>;
  parserAvailable: () => boolean;
  parserUnavailableReason: () => string | undefined;
};

/** The real toolchain — what both harnesses get when they pass no argument. */
const REAL_TOOLCHAIN: DeriveToolchain = {
  initFormatter,
  formatterAvailable,
  formatterUnavailableReason,
  initParser,
  parserAvailable,
  parserUnavailableReason,
};

export async function requireDeriveToolchain(
  // Injected for the same reason `resolveComparableTree` takes `git`: the interesting cases
  // here are the two REFUSALS, and they are unreachable from a test that can only observe a
  // machine where both packages are installed — which is every machine that can run this
  // suite, since both are devDependencies. Defaulted, so neither caller passes anything.
  toolchain: DeriveToolchain = REAL_TOOLCHAIN,
): Promise<void> {
  await toolchain.initFormatter();
  if (!toolchain.formatterAvailable()) {
    throw new Error(
      "@biomejs/biome is required here — this harness byte-compares, and unformatted output " +
        `would produce spurious diffs that read as reach regressions. ${toolchain.formatterUnavailableReason()}`,
    );
  }
  await toolchain.initParser();
  if (!toolchain.parserAvailable()) {
    throw new Error(
      `@babel/parser is required here — this harness derives every connector. ${toolchain.parserUnavailableReason()}`,
    );
  }
}

/**
 * The comparability preamble both harnesses run before they may record or compare: HEAD is
 * readable, `packages/mcp-connectors` is clean, and the tree object resolves.
 *
 * This is the part that most needed to be shared. These rules decide whether a baseline may be
 * written or compared **at all**, so the writer and the reader disagreeing about them is
 * exactly the single failure `scripts/reach-baseline.ts`'s header says this pair must not have
 * — the reason it already imports `measure`, `connectorDirs` and `git` rather than
 * reimplementing them. The comparability rules were the one part left copied.
 *
 * `git` is injected rather than imported because it lives in `scripts/reach.ts`, which imports
 * this module; taking it as a parameter keeps that edge one-way.
 *
 * Returns the refusal text for the caller to print and exit(2) on, or the resolved tree object.
 * The caller formats it — `reach.ts` prefixes a blank line, `reach-baseline.ts` does not.
 */
export function resolveComparableTree(
  root: string,
  git: (root: string, args: string[]) => { value: string; error: string },
): { refusal: string } | { connectorsTree: string; head: string } {
  const head = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--porcelain", "--", "packages/mcp-connectors"]);
  // A failed `git status` must not be read as "clean": status.value === "" either way, so
  // status.error (not just head.error) has to reach assertComparable, or a non-zero exit
  // here makes the dirty gate silently disappear.
  const refusal = assertComparable({
    commit: head.value,
    dirty: status.value !== "",
    gitError: head.error !== "" ? head.error : status.error,
  });
  if (refusal !== undefined) return { refusal };

  // Keyed on the tree object of packages/mcp-connectors — the only path this harness reads —
  // not on HEAD: see assertComparable's docstring for why a commit SHA is the wrong key.
  const connectorsTree = git(root, ["rev-parse", "HEAD:packages/mcp-connectors"]);
  const treeRefusal = connectorsTreeRefusal(connectorsTree.error);
  if (treeRefusal !== undefined) return { refusal: treeRefusal };

  return { connectorsTree: connectorsTree.value, head: head.value };
}
