import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNimbusRoot } from "../../src/golden/resolve.ts";
import { tempDirs } from "../support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

function fakeNimbus(): string {
  const root = tmp.make("nimbus-");
  mkdirSync(join(root, "packages", "mcp-connectors", "shared"), { recursive: true });
  writeFileSync(join(root, "packages", "mcp-connectors", "shared", "mcp-tool-kit.ts"), "");
  return root;
}

describe("resolveNimbusRoot", () => {
  it("prefers the explicit flag", () => {
    const root = fakeNimbus();
    expect(resolveNimbusRoot({ flag: root, scriptDir: "/nowhere" })).toBe(root);
  });

  it("falls back to the environment variable", () => {
    const root = fakeNimbus();
    expect(resolveNimbusRoot({ env: root, scriptDir: "/nowhere" })).toBe(root);
  });

  it("rejects a path that exists but lacks the marker file", () => {
    const empty = tmp.make("empty-");
    expect(() => resolveNimbusRoot({ flag: empty, scriptDir: "/nowhere" })).toThrow(/marker/i);
  });

  it("rejects an explicit flag that does not exist, even when a valid sibling checkout exists on disk", () => {
    // Build a synthetic workspace containing a *real, valid* Nimbus sibling exactly
    // where resolveNimbusRoot's sibling probe (resolve(scriptDir, "..", "..", name))
    // would find it, then prove an explicit bogus --nimbus-root still fails loudly
    // instead of silently falling through to that valid sibling. Fully hermetic: no
    // dependency on this machine's actual checkout layout.
    const workspace = tmp.make("workspace-");
    const validSibling = join(workspace, "Nimbus");
    mkdirSync(join(validSibling, "packages", "mcp-connectors", "shared"), { recursive: true });
    writeFileSync(
      join(validSibling, "packages", "mcp-connectors", "shared", "mcp-tool-kit.ts"),
      "",
    );

    const scriptDir = join(workspace, "some-project", "scripts");
    mkdirSync(scriptDir, { recursive: true });

    const bogusFlag = join(workspace, "definitely-not-here");

    let thrown: unknown;
    try {
      resolveNimbusRoot({ flag: bogusFlag, scriptDir });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/marker/i);
    expect(message).toContain(bogusFlag);
  });

  it("lists every attempted path when nothing resolves", () => {
    expect(() => resolveNimbusRoot({ scriptDir: "/nowhere" })).toThrow(/tried/i);
  });

  it("records a sibling that exists but is not a checkout, rather than failing on it", () => {
    // The other half of the policy the docstring states — explicit sources fail loudly, GUESSES
    // fall through — and the only arm of resolveRoot no test reached. The test above walks a
    // scriptDir whose siblings do not exist at all, so it exercises the "does not exist" push;
    // this one exercises the "exists but has no marker" push, which is the arm that could
    // plausibly have thrown instead, since the identical condition one line above DOES throw for
    // an explicit source. Throwing here would turn an unrelated directory named "Nimbus" sitting
    // beside the checkout into a hard failure rather than a rejected guess.
    //
    // It asserts the message rather than merely that something threw: reaching the bottom of the
    // loop is what "recorded and skipped" MEANS, and only the `tried` line proves the guess was
    // considered rather than never probed at all.
    //
    // Only one sibling is built. NIMBUS probes "Nimbus" then "nimbus", but this suite also runs
    // on a case-insensitive filesystem, where the two names are one directory — so a second
    // fixture proving the probe continues past the rejected one cannot be built portably here.
    const workspace = tmp.make("sibling-");
    mkdirSync(join(workspace, "Nimbus"), { recursive: true });
    const scriptDir = join(workspace, "some-project", "scripts");
    mkdirSync(scriptDir, { recursive: true });

    let thrown: unknown;
    try {
      resolveNimbusRoot({ scriptDir });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(join(workspace, "Nimbus"));
    expect(message).toMatch(/marker file missing/);
    // Recorded as a tried GUESS, not reported as the explicit-source failure — the two messages
    // differ, and only the sibling one carries the "sibling directory" source.
    expect(message).toContain("sibling directory");
    expect(message).not.toMatch(/--nimbus-root\) exists/);
  });
});
