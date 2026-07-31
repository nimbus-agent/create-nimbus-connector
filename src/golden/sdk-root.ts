import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const MARKER = join("sdks", "typescript", "package.json");

export type ResolveOptions = {
  readonly flag?: string;
  readonly env?: string;
  /** Directory of the running script; siblings are probed relative to this, not cwd. */
  readonly scriptDir: string;
};

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
