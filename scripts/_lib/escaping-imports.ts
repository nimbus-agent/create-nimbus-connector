/**
 * A pure-Bun replacement for `grep -rn "\.\./\.\." <dir>`.
 *
 * No external binary, so it behaves identically under PowerShell and Git Bash — platform
 * equality is a project non-negotiable, and shelling out to grep silently does nothing on a
 * Windows box without Git Bash on PATH, which is the "check that never runs" failure this
 * repo keeps designing against.
 *
 * What it is checking: a generated standalone package must be self-contained. A relative
 * import that climbs out of it (`../../src/...`) works in the temp tree the harness builds
 * and breaks for every real consumer, and nothing else in the pipeline sees it — `tsc` is
 * happy because the file is right there.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every line under `dir` containing "../..", in grep's `-n` format
 * ("path:line:content", forward slashes), or "" when there are none.
 *
 * A missing directory yields "" rather than throwing: the caller scopes this to a generated
 * package's src/, and "the directory is not there" is already caught, loudly, by the checks
 * that build and run that package.
 */
export function findEscapingImports(dir: string): string {
  const matches: string[] = [];

  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const lines = readFileSync(full, "utf8").split("\n");
        for (const [i, line] of lines.entries()) {
          if (line.includes("../..")) {
            matches.push(`${relative(dir, full).replaceAll("\\", "/")}:${i + 1}:${line}`);
          }
        }
      }
    }
  };

  if (existsSync(dir)) walk(dir);
  return matches.join("\n");
}
