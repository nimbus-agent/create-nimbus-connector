import { join } from "node:path";
import { type ResolveOptions, type RootSpec, resolveRoot } from "./resolve-root.ts";

export type { ResolveOptions };

export const MARKER = join("sdks", "typescript", "package.json");

const SDK: RootSpec = {
  marker: MARKER,
  siblings: ["nimbus-sdk"],
  flagName: "--sdk-root",
  envName: "$NIMBUS_SDK_ROOT",
  subject: "the nimbus-sdk checkout",
  checkoutOf: "nimbus-sdk",
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
 * docs/ARCHITECTURE.md and CONTRIBUTING.md document) or as `--sdk-root <path>` — the name SDK's
 * `flagName` above already carries, so it is what resolveSdkRoot's own failure message tells
 * you to pass. Both are accepted because a script that rejects the flag its error message
 * names is a trap, and the positional form is the one the docs teach.
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
  return resolveRoot(opts, SDK);
}
