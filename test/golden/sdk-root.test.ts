import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSdkArgs, resolveSdkRoot } from "../../src/golden/sdk-root.ts";
import { tempDirs } from "../support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

function fakeSdk(): string {
  const root = tmp.make("nimbus-sdk-");
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
    const empty = tmp.make("empty-");
    expect(() => resolveSdkRoot({ flag: empty, scriptDir: "/nowhere" })).toThrow(/marker/i);
  });

  it("rejects an explicit flag that does not exist, even when a valid sibling checkout exists on disk", () => {
    // Build a synthetic workspace containing a *real, valid* nimbus-sdk sibling exactly
    // where resolveSdkRoot's sibling probe (resolve(scriptDir, "..", "..", name)) would
    // find it, then prove an explicit bogus --sdk-root still fails loudly instead of
    // silently falling through to that valid sibling. Fully hermetic: no dependency on
    // this machine's actual checkout layout.
    const workspace = tmp.make("workspace-");
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

  it("reports a sibling directory that exists but lacks the checkout marker", () => {
    const workspace = tmp.make("workspace-");
    const sibling = join(workspace, "nimbus-sdk");
    mkdirSync(sibling, { recursive: true });

    const scriptDir = join(workspace, "some-project", "scripts");
    mkdirSync(scriptDir, { recursive: true });

    let thrown: unknown;
    try {
      resolveSdkRoot({ scriptDir });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(sibling);
    expect(message).toMatch(/tried/i);
    expect(message).not.toMatch(/does not exist/);
    expect(message).toMatch(/marker file missing/);
    // The SDK resolver probes only this sibling name, so the whole diagnostic must classify
    // the existing directory as marker-missing rather than absent.
  });

  it("lists every attempted path when nothing resolves", () => {
    expect(() => resolveSdkRoot({ scriptDir: "/nowhere" })).toThrow(/tried/i);
  });
});

describe("parseSdkArgs", () => {
  it("accepts the bare positional form README.md documents", () => {
    expect(parseSdkArgs(["/c/gitrep/nimbus-sdk"])).toEqual({
      flag: "/c/gitrep/nimbus-sdk",
      registry: false,
    });
  });

  it("accepts the --sdk-root form the design doc's pre-release gate table documents", () => {
    expect(parseSdkArgs(["--sdk-root", "/c/gitrep/nimbus-sdk"])).toEqual({
      flag: "/c/gitrep/nimbus-sdk",
      registry: false,
    });
  });

  it("returns no flag when nothing is passed, leaving env/sibling probing to resolve", () => {
    expect(parseSdkArgs([])).toEqual({ registry: false });
  });

  it("selects registry mode, which carries no SDK root at all", () => {
    expect(parseSdkArgs(["--registry"])).toEqual({ registry: true });
  });

  it("rejects --registry combined with an SDK root, in either order", () => {
    // Not a precedence question: the two resolve @nimbus-dev/sdk from different places and
    // answer different questions, so silently preferring one would misreport what ran.
    expect(() => parseSdkArgs(["--registry", "/c/gitrep/nimbus-sdk"])).toThrow(/--registry/);
    expect(() => parseSdkArgs(["--sdk-root", "/x", "--registry"])).toThrow(/takes no SDK root/i);
  });

  it("rejects an unknown flag rather than resolving it as a directory", () => {
    expect(() => parseSdkArgs(["--sdk-rot", "/x"])).toThrow(/--sdk-rot/);
  });

  it("rejects --sdk-root with no following value", () => {
    expect(() => parseSdkArgs(["--sdk-root"])).toThrow(/--sdk-root/);
  });

  it("rejects two conflicting roots instead of silently keeping one", () => {
    expect(() => parseSdkArgs(["/a", "--sdk-root", "/b"])).toThrow(/twice/i);
    expect(() => parseSdkArgs(["/a", "/b"])).toThrow(/twice/i);
  });
});
