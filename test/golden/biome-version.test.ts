import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBiomeVersion } from "../../src/golden/biome-version.ts";

function fakeRoot(pkg: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "nimbus-biome-"));
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg), "utf8");
  return root;
}

describe("checkBiomeVersion", () => {
  it("returns undefined when the pin (stripped of its range prefix) matches", () => {
    const root = fakeRoot({ devDependencies: { "@biomejs/biome": "^2.5.6" } });
    expect(checkBiomeVersion(root, "2.5.6")).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("warns, without throwing, when the pin differs from the resolved version", () => {
    const root = fakeRoot({ devDependencies: { "@biomejs/biome": "^2.4.0" } });
    const warning = checkBiomeVersion(root, "2.5.6");
    expect(warning).toBeDefined();
    expect(warning).toContain("2.5.6");
    expect(warning).toContain("2.4.0");
    rmSync(root, { recursive: true, force: true });
  });

  it("warns, without throwing, when package.json cannot be read", () => {
    const root = join(tmpdir(), "nimbus-biome-does-not-exist");
    const warning = checkBiomeVersion(root, "2.5.6");
    expect(warning).toBeDefined();
    expect(warning).toMatch(/could not read/i);
  });

  it("warns, without throwing, when there is no @biomejs/biome devDependency", () => {
    const root = fakeRoot({ devDependencies: {} });
    const warning = checkBiomeVersion(root, "2.5.6");
    expect(warning).toBeDefined();
    expect(warning).toMatch(/declares no/i);
    rmSync(root, { recursive: true, force: true });
  });
});
