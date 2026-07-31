import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A per-file scratch-directory pool: mkdtemp that remembers what it created, so a test
 * file can remove all of it in one afterAll.
 *
 * The tests that predate this helper called mkdtempSync directly and never cleaned up;
 * %TEMP% had accumulated hundreds of `expectations-*` and `nimbus-sdk-*` directories.
 * Cleanup cannot go inside the creating function — several callers hand the path straight
 * to the code under test and must still be able to read it — so it is deferred.
 *
 * Deliberately a factory rather than module-level state: bun:test shares one module
 * registry across test files, so a single shared array is drained by whichever file's
 * afterAll fires first, and directories created by a file whose hooks interleave with it
 * survive. (Observed: exactly one `workspace-` and one `empty-` leaked per full-suite run
 * while the same file was clean in isolation.) One pool per file has no such coupling.
 *
 * Usage, once per test file:
 *
 *   const tmp = tempDirs();
 *   afterAll(tmp.cleanup);
 *   ... tmp.make("expectations-")
 */
export type TempDirs = {
  make: (prefix: string) => string;
  cleanup: () => void;
};

export function tempDirs(): TempDirs {
  const created: string[] = [];
  return {
    make(prefix: string): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      created.push(dir);
      return dir;
    },
    /**
     * `force` so a directory a test already removed is not an error, and never throws —
     * a cleanup failure must not turn a passing suite red; it should only leave the
     * directory behind, exactly as the old code did unconditionally.
     */
    cleanup(): void {
      while (created.length > 0) {
        const dir = created.pop()!;
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best effort: a locked directory on Windows is not a test failure.
        }
      }
    },
  };
}
