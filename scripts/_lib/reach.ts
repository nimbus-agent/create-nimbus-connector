import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { takeValue } from "../../src/cli.ts";
import type { Blocker } from "../../src/derive/blockers.ts";
import { type Derivation, deriveSpec } from "../../src/derive/index.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath, type GeneratedFile } from "../../src/types.ts";
import { validateSpec } from "../../src/validate.ts";

/**
 * `bun run reach`'s own argument parsing, lifted out of scripts/reach.ts on the
 * scripts/_lib/golden-diff.ts precedent: `bunfig.toml` enforces `coverageThreshold` PER FILE,
 * and Bun puts a file in the coverage report the moment a test imports it. scripts/reach.ts's
 * `main()` needs a Nimbus checkout and cannot clear the floor, so anything a test reaches for
 * must live somewhere that does not drag `main()` in with it.
 */
export function parseArgs(argv: readonly string[]): {
  names: string[];
  nimbusRoot?: string;
  baseline: boolean;
  verbose: boolean;
} {
  const names: string[] = [];
  let nimbusRoot: string | undefined;
  let baseline = false;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--nimbus-root") nimbusRoot = takeValue(argv, ++i, "--nimbus-root");
    else if (a === "--baseline") baseline = true;
    else if (a === "--verbose") verbose = true;
    else if (a?.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else if (a !== undefined) names.push(a);
  }
  return { names, nimbusRoot, baseline, verbose };
}

export type Tier = "blocked" | "emits" | "server-identical" | "all-identical";

export type ConnectorResult = { name: string; tier: Tier; blockers: Blocker[] };

const SERVER = "src/server.ts";

/**
 * Reads a real connector's tracked files, keyed by forward-slash relative path, normalising
 * line endings on THAT side only — the same asymmetry scripts/_lib/golden-diff.ts's
 * diffAgainstReal uses, and for the same reason: normalise what this repository does not
 * control, compare verbatim what it produces. Normalising the generated side too would mask a
 * CRLF leak from the emitter rather than surface it.
 *
 * Safe because .gitattributes pins `* text=auto eol=lf`, so the working tree is LF even under
 * core.autocrlf=true. Verified on Windows: all six emitted files are LF-only, including
 * README.md, which formatAll does not touch.
 *
 * Every one of the 94 connectors carries a `node_modules/` from `bun install`, not from git —
 * it is not part of the connector's authored source, and it is where this walk must not go:
 * on Windows the workspace-package entries under it are junctions, and Bun's `Dirent.isDirectory()`
 * reports the link itself rather than its target, so treating one as a file and reading it
 * throws EISDIR. Skipped by name rather than by resolving link targets, since no real connector
 * has ever had reason to name a source directory `node_modules`.
 */
export function walkConnector(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (sub: string): void => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const rel = sub === "" ? entry.name : `${sub}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else out.set(rel, readFileSync(join(dir, rel), "utf8").replaceAll("\r\n", "\n"));
    }
  };
  walk("");
  return out;
}

/**
 * One measurement, decidable entirely from its arguments — no filesystem, no git. The read side
 * (walkConnector against a real connector's directory) lives in the two shells (scripts/reach.ts
 * and scripts/reach-baseline.ts) so a connector this harness cannot even read — a dangling
 * symlink, a permissions error — becomes a `read-error` blocker there rather than aborting the
 * whole sweep; this function only ever sees bytes that were read successfully.
 */
export function measure(name: string, files: ReadonlyMap<string, string>): ConnectorResult {
  const server = files.get(SERVER);
  const manifest = files.get("nimbus.extension.json");
  if (server === undefined || manifest === undefined) {
    return {
      name,
      tier: "blocked",
      blockers: [
        { kind: server === undefined ? "no-server" : "no-manifest", detail: name, line: 0 },
      ],
    };
  }

  const derivation = deriveSpec({ server, manifest });
  if (!derivation.ok) return { name, tier: "blocked", blockers: derivation.blockers };

  // parseSpec and validateSpec ARE the `emits` tier boundary: a derived spec that trips
  // RESERVED_IDENTIFIERS is genuinely not generatable today, and counting it is the point. This
  // try is deliberately narrow — it must NOT also wrap generate()/formatAll() below, or an
  // emitter bug becomes indistinguishable in the histogram from a genuine spec rejection.
  let spec: ReturnType<typeof parseSpec>;
  try {
    spec = parseSpec(derivation.spec);
    validateSpec(spec);
  } catch (err) {
    return {
      name,
      tier: "blocked",
      blockers: [
        {
          kind: "rejected-by-validate",
          detail: err instanceof Error ? err.message : String(err),
          line: 0,
        },
      ],
    };
  }

  // A separate try/catch and a separate blocker kind: this is an emitter defect, not a spec
  // rejection, and a connector landing here must not take down the other 93 in the sweep.
  try {
    const generated = formatAll(generate(spec));
    return { name, tier: tierFor({ derivation, generated, real: files }), blockers: [] };
  } catch (err) {
    return {
      name,
      tier: "blocked",
      blockers: [
        {
          kind: "emitter-error",
          detail: err instanceof Error ? err.message : String(err),
          line: 0,
        },
      ],
    };
  }
}

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
