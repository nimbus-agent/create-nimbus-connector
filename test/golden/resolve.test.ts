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

  it("reports a sibling directory that exists but lacks the checkout marker", () => {
    const workspace = tmp.make("workspace-");
    const sibling = join(workspace, "Nimbus");
    mkdirSync(sibling, { recursive: true });

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
    expect(message).toContain(sibling);
    expect(message).toMatch(/tried/i);
    expect(message).not.toMatch(/does not exist/);
    expect(message).toMatch(/marker file missing/);
    // Both "Nimbus" and "nimbus" are probed, so a case-insensitive filesystem lists this
    // same directory twice. Assert on content, never on how many paths were tried.
  });

  it("lists every attempted path when nothing resolves", () => {
    expect(() => resolveNimbusRoot({ scriptDir: "/nowhere" })).toThrow(/tried/i);
  });
});
