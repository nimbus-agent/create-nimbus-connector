import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSdkRoot } from "../../src/golden/sdk-root.ts";

function fakeSdk(): string {
  const root = mkdtempSync(join(tmpdir(), "nimbus-sdk-"));
  mkdirSync(join(root, "sdks", "typescript"), { recursive: true });
  writeFileSync(join(root, "sdks", "typescript", "package.json"), "");
  return root;
}

describe("resolveSdkRoot", () => {
  it("prefers the explicit flag", () => {
    const root = fakeSdk();
    expect(resolveSdkRoot({ flag: root, scriptDir: "/nowhere" })).toBe(root);
  });

  it("falls back to the environment variable", () => {
    const root = fakeSdk();
    expect(resolveSdkRoot({ env: root, scriptDir: "/nowhere" })).toBe(root);
  });

  it("rejects a path that exists but lacks the marker file", () => {
    const empty = mkdtempSync(join(tmpdir(), "empty-"));
    expect(() => resolveSdkRoot({ flag: empty, scriptDir: "/nowhere" })).toThrow(/marker/i);
  });

  it("rejects an explicit flag that does not exist, even when a valid sibling checkout exists on disk", () => {
    // Build a synthetic workspace containing a *real, valid* nimbus-sdk sibling exactly
    // where resolveSdkRoot's sibling probe (resolve(scriptDir, "..", "..", name)) would
    // find it, then prove an explicit bogus --sdk-root still fails loudly instead of
    // silently falling through to that valid sibling. Fully hermetic: no dependency on
    // this machine's actual checkout layout.
    const workspace = mkdtempSync(join(tmpdir(), "workspace-"));
    const validSibling = join(workspace, "nimbus-sdk");
    mkdirSync(join(validSibling, "sdks", "typescript"), { recursive: true });
    writeFileSync(join(validSibling, "sdks", "typescript", "package.json"), "");

    const scriptDir = join(workspace, "some-project", "scripts");
    mkdirSync(scriptDir, { recursive: true });

    const bogusFlag = join(workspace, "definitely-not-here");

    let thrown: unknown;
    try {
      resolveSdkRoot({ flag: bogusFlag, scriptDir });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/marker/i);
    expect(message).toContain(bogusFlag);
  });

  it("lists every attempted path when nothing resolves", () => {
    expect(() => resolveSdkRoot({ scriptDir: "/nowhere" })).toThrow(/tried/i);
  });
});
