import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const MARKER = join("sdks", "typescript", "package.json");

export type ResolveOptions = {
  readonly flag?: string;
  readonly env?: string;
  /** Directory of the running script; siblings are probed relative to this, not cwd. */
  readonly scriptDir: string;
};

export type SdkArgs = Pick<ResolveOptions, "flag"> & {
  /**
   * Resolve @nimbus-dev/sdk from the npm registry instead of a local checkout — the mode
   * that verifies the actually-published tarball.
   */
  registry: boolean;
};

/**
 * Parse scripts/standalone-acceptance.ts's argv.
 *
 * The SDK root may be given positionally (`bun run standalone-acceptance <path>`, the form
 * README.md documents) or as `--sdk-root <path>` (the form the design doc's pre-release
 * gate table documents, and the name resolveSdkRoot already uses in its error messages and
 * its "Pass --sdk-root <path>" hint). Both are accepted so the two documents agree with the
 * script and with each other.
 *
 * `--registry` selects the published-tarball mode and takes no SDK root; combining the two
 * is a contradiction, not a precedence question, so it errors.
 *
 * Unknown flags are rejected rather than silently treated as a path, mirroring
 * scripts/diff-golden.ts's parser — otherwise `--sdk-rot /x` resolves "--sdk-rot" as a
 * directory and dies with a confusing "does not exist".
 */
export function parseSdkArgs(argv: readonly string[]): SdkArgs {
  let sdkRoot: string | undefined;
  let registry = false;
  const set = (value: string): void => {
    if (sdkRoot !== undefined) {
      throw new Error(`The SDK root was given twice: "${sdkRoot}" and "${value}" — pass it once.`);
    }
    sdkRoot = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--registry") {
      registry = true;
    } else if (a === "--sdk-root") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--sdk-root requires a value");
      set(value);
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      set(a);
    }
  }
  if (registry && sdkRoot !== undefined) {
    throw new Error(
      `--registry resolves @nimbus-dev/sdk from npm and takes no SDK root, but "${sdkRoot}" ` +
        "was given. Pass one or the other — they answer different questions.",
    );
  }
  return sdkRoot === undefined ? { registry } : { registry, flag: sdkRoot };
}

export function resolveSdkRoot(opts: ResolveOptions): string {
  const tried: string[] = [];
  const candidates: { path: string; source: string }[] = [];

  if (opts.flag !== undefined) candidates.push({ path: resolve(opts.flag), source: "--sdk-root" });
  if (opts.env !== undefined && opts.env !== "") {
    candidates.push({ path: resolve(opts.env), source: "$NIMBUS_SDK_ROOT" });
  }
  for (const name of ["nimbus-sdk"]) {
    candidates.push({
      path: resolve(opts.scriptDir, "..", "..", name),
      source: "sibling directory",
    });
  }

  for (const c of candidates) {
    const isExplicit = c.source === "--sdk-root" || c.source === "$NIMBUS_SDK_ROOT";

    if (!existsSync(c.path)) {
      // An explicit flag/env value is a user assertion, not a guess: a typo must fail
      // loudly rather than silently falling through to sibling-directory probing.
      if (isExplicit) {
        throw new Error(`${c.path} (${c.source}) does not exist — marker file missing: ${MARKER}`);
      }
      tried.push(`  ${c.path}  (${c.source}) — does not exist`);
      continue;
    }
    if (!existsSync(join(c.path, MARKER))) {
      if (isExplicit) {
        throw new Error(
          `${c.path} (${c.source}) exists but is not a nimbus-sdk checkout — marker file missing: ${MARKER}`,
        );
      }
      tried.push(`  ${c.path}  (${c.source}) — marker file missing: ${MARKER}`);
      continue;
    }
    return c.path;
  }

  throw new Error(
    `Could not locate the nimbus-sdk checkout. Tried:\n${tried.join("\n")}\n\n` +
      `Pass --sdk-root <path> or set NIMBUS_SDK_ROOT.`,
  );
}
