import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export type ResolveOptions = {
  readonly flag?: string;
  readonly env?: string;
  /** Directory of the running script; siblings are probed relative to this, not cwd. */
  readonly scriptDir: string;
};

/**
 * Everything that differs between the two checkouts this project has to locate.
 *
 * The locating *policy* — explicit sources fail loudly, guesses fall through, the marker
 * file decides what counts as a checkout — is identical for both and lives in resolveRoot
 * below. Only these six values differ, so only these six are data.
 */
export type RootSpec = {
  /** Relative path that must exist inside a valid checkout; how one is recognised. */
  readonly marker: string;
  /** Sibling directory names to probe, in order, when nothing explicit was given. */
  readonly siblings: readonly string[];
  /** The CLI flag that supplies this root, e.g. `--nimbus-root`. */
  readonly flagName: string;
  /** The environment variable, written as a user sees it, e.g. `$NIMBUS_ROOT`. */
  readonly envName: string;
  /** What could not be found, e.g. `the Nimbus monorepo`. */
  readonly subject: string;
  /** Names the checkout kind in "exists but is not a <X> checkout". */
  readonly checkoutOf: string;
};

/**
 * Resolve a checkout root from an explicit flag, an environment variable, or sibling
 * directories — in that order of precedence.
 *
 * The load-bearing rule: an explicit flag or env value is a user *assertion*, not a guess.
 * A typo in one must fail loudly rather than silently falling through to sibling probing,
 * because falling through makes a bogus `--nimbus-root` resolve to a real checkout and
 * report PASS — a green run that verified something other than what was asked for. Both
 * callers' test suites pin this behaviour with a hermetic case: an explicit path that does
 * not exist must throw even when a valid sibling is sitting right there.
 */
export function resolveRoot(opts: ResolveOptions, spec: RootSpec): string {
  const tried: string[] = [];
  const candidates: { path: string; source: string }[] = [];

  if (opts.flag !== undefined) candidates.push({ path: resolve(opts.flag), source: spec.flagName });
  if (opts.env !== undefined && opts.env !== "") {
    candidates.push({ path: resolve(opts.env), source: spec.envName });
  }
  for (const name of spec.siblings) {
    candidates.push({
      path: resolve(opts.scriptDir, "..", "..", name),
      source: "sibling directory",
    });
  }

  for (const c of candidates) {
    const isExplicit = c.source === spec.flagName || c.source === spec.envName;

    if (!existsSync(c.path)) {
      if (isExplicit) {
        throw new Error(
          `${c.path} (${c.source}) does not exist — marker file missing: ${spec.marker}`,
        );
      }
      tried.push(`  ${c.path}  (${c.source}) — does not exist`);
      continue;
    }
    if (!existsSync(join(c.path, spec.marker))) {
      if (isExplicit) {
        throw new Error(
          `${c.path} (${c.source}) exists but is not a ${spec.checkoutOf} checkout — marker file missing: ${spec.marker}`,
        );
      }
      tried.push(`  ${c.path}  (${c.source}) — marker file missing: ${spec.marker}`);
      continue;
    }
    return c.path;
  }

  throw new Error(
    `Could not locate ${spec.subject}. Tried:\n${tried.join("\n")}\n\n` +
      `Pass ${spec.flagName} <path> or set ${spec.envName.slice(1)}.`,
  );
}
