import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Strip a semver range prefix (^, ~, >=, etc.) down to a bare version string. */
function bareVersion(pin: string): string {
  return pin.replace(/^[^\d]*/, "");
}

/**
 * Compare this repo's resolved Biome version against the monorepo's pinned
 * `@biomejs/biome` devDependency, read from `<nimbusRoot>/package.json`.
 *
 * Returns a warning line when the versions differ, or when the pin cannot be read or is
 * absent; returns `undefined` when they match. Never throws — a version mismatch (or an
 * unreadable pin) is a warning, not a hard failure, since a diff measured under a
 * different formatter version is not trustworthy evidence either way, but the harness
 * should still be able to report it.
 */
export function checkBiomeVersion(nimbusRoot: string, resolved: string): string | undefined {
  const pkgPath = join(nimbusRoot, "package.json");
  let pin: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    pin = pkg.devDependencies?.["@biomejs/biome"];
  } catch (err) {
    return (
      `Warning: could not read ${pkgPath} to check the @biomejs/biome version pin ` +
      `(${(err as Error).message}) — skipping the version-match check.`
    );
  }
  if (pin === undefined) {
    return (
      `Warning: ${pkgPath} declares no "@biomejs/biome" devDependency — ` +
      "skipping the version-match check."
    );
  }
  const bare = bareVersion(pin);
  if (bare === resolved) return undefined;
  return (
    `Warning: this repo's resolved Biome version (${resolved}) does not match the ` +
    `monorepo's pinned "@biomejs/biome": "${pin}" — a diff measured under a different ` +
    "formatter version is not trustworthy evidence either way."
  );
}
