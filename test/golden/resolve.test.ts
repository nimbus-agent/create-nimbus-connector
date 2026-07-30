import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNimbusRoot } from "../../src/golden/resolve.ts";

function fakeNimbus(): string {
  const root = mkdtempSync(join(tmpdir(), "nimbus-"));
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
    const empty = mkdtempSync(join(tmpdir(), "empty-"));
    expect(() => resolveNimbusRoot({ flag: empty, scriptDir: "/nowhere" })).toThrow(/marker/i);
  });

  it("rejects an explicit flag path that does not exist, without falling back to a sibling", () => {
    // scriptDir here resolves to a real ancestor of the actual project checkout, so a
    // silently-successful sibling fallback would mask a typo'd --nimbus-root.
    expect(() =>
      resolveNimbusRoot({ flag: "/definitely/not/here", scriptDir: import.meta.dir }),
    ).toThrow(/marker/i);
  });

  it("lists every attempted path when nothing resolves", () => {
    expect(() => resolveNimbusRoot({ scriptDir: "/nowhere" })).toThrow(/tried/i);
  });
});
