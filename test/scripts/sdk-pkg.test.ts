/**
 * Unit tests for the SDK-package resolution both installing harnesses share.
 *
 * This block used to sit at MODULE SCOPE in scripts/standalone-acceptance.ts and again in
 * scripts/runtime-acceptance.ts, reading `process.argv` directly. That is what made it
 * untestable and what made both harnesses untestable: importing either one consumed the
 * importer's argv — a test runner's flags, in practice — and then went looking for an SDK
 * checkout the machine may not have. Taking argv, the environment and the script directory
 * as parameters is the change these tests exist to lock in.
 *
 * What it decides matters beyond tidiness. `undefined` means "leave the emitted
 * `@nimbus-dev/sdk` dependency exactly as generated so bun resolves it from npm", which is
 * the only mode that can answer "does the PUBLISHED tarball satisfy the contract?" — the
 * question that catches `dist` missing from the package's `files` array. A resolution that
 * quietly returned a local path in `--registry` mode would answer a different question and
 * still report green, which is the failure shape this repo keeps removing.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertLocalSdkBuilt,
  modeBanner,
  resolveSdkPkg,
  withLocalSdk,
} from "../../scripts/_lib/sdk-pkg.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";
import { tempDirs } from "../support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

const repoRoot = join(import.meta.dir, "..", "..");

/** A directory that passes resolveSdkRoot's marker check (sdks/typescript/package.json). */
function fakeSdkCheckout(): string {
  const root = tmp.make("cnc-sdkpkg-");
  mkdirSync(join(root, "sdks", "typescript"), { recursive: true });
  writeFileSync(join(root, "sdks", "typescript", "package.json"), "{}\n", "utf8");
  return root;
}

describe("resolveSdkPkg", () => {
  it("returns undefined for --registry, resolving nothing locally", () => {
    // Deliberately passed an environment value AND a script directory that would both
    // resolve if they were consulted: --registry has to win outright, or a machine with
    // $NIMBUS_SDK_ROOT set would silently run the local-checkout mode while the operator
    // believed they were testing the published tarball.
    const local = fakeSdkCheckout();

    expect(resolveSdkPkg(["--registry"], local, local)).toBeUndefined();
  });

  it("points at sdks/typescript inside an explicit --sdk-root", () => {
    const root = fakeSdkCheckout();

    expect(resolveSdkPkg(["--sdk-root", root], undefined, "/nowhere")).toBe(
      join(root, "sdks", "typescript"),
    );
  });

  it("accepts the SDK root positionally, the form README.md documents", () => {
    const root = fakeSdkCheckout();

    expect(resolveSdkPkg([root], undefined, "/nowhere")).toBe(join(root, "sdks", "typescript"));
  });

  it("falls back to $NIMBUS_SDK_ROOT when no root is on the command line", () => {
    const root = fakeSdkCheckout();

    expect(resolveSdkPkg([], root, "/nowhere")).toBe(join(root, "sdks", "typescript"));
  });

  it("prefers an explicit flag over the environment variable", () => {
    const flagged = fakeSdkCheckout();
    const fromEnv = fakeSdkCheckout();

    expect(resolveSdkPkg(["--sdk-root", flagged], fromEnv, "/nowhere")).toBe(
      join(flagged, "sdks", "typescript"),
    );
  });

  it("treats an empty $NIMBUS_SDK_ROOT as unset rather than as the current directory", () => {
    // An exported-but-empty variable is the normal shape of "I unset this in CI". Passing
    // "" through to resolve() would yield the process cwd, which is this repo — a directory
    // that is not an SDK checkout, producing a marker-file error that names the wrong path.
    expect(() => resolveSdkPkg([], "", "/nowhere")).toThrow(/Could not locate the nimbus-sdk/);
  });

  it("fails loudly on an --sdk-root that does not exist instead of guessing", () => {
    const missing = join(tmp.make("cnc-sdkpkg-missing-"), "not-here");

    expect(() => resolveSdkPkg(["--sdk-root", missing], undefined, "/nowhere")).toThrow(
      /does not exist/,
    );
  });

  it("rejects --registry combined with an SDK root rather than picking one", () => {
    // The two answer different questions, so a precedence rule would silently answer the
    // one the operator did not ask.
    expect(() => resolveSdkPkg(["--registry", "/some/sdk"], undefined, "/nowhere")).toThrow(
      /--registry resolves @nimbus-dev\/sdk from npm and takes no SDK root/,
    );
  });

  it("rejects an unknown flag rather than treating it as a path", () => {
    expect(() => resolveSdkPkg(["--sdk-rot", "/x"], undefined, "/nowhere")).toThrow(
      "Unknown flag: --sdk-rot",
    );
  });
});

describe("assertLocalSdkBuilt", () => {
  it("passes when the local checkout has its connector-kit build output", () => {
    const pkg = tmp.make("cnc-sdkbuilt-");
    mkdirSync(join(pkg, "dist", "connector-kit"), { recursive: true });
    writeFileSync(join(pkg, "dist", "connector-kit", "index.js"), "", "utf8");

    expect(() => assertLocalSdkBuilt(pkg)).not.toThrow();
  });

  it("refuses an unbuilt local checkout, saying what to run", () => {
    // Fail-closed and early. Without this the run gets as far as `bunx tsc --noEmit`, which
    // fails to resolve the kit's types and reports a wall of TS2307s about the GENERATED
    // package — a real-looking emitter failure whose actual cause is one missing build.
    const pkg = tmp.make("cnc-sdkunbuilt-");

    expect(() => assertLocalSdkBuilt(pkg)).toThrow(/is missing — run `bun run build` in the SDK/);
  });

  it("checks for dist/connector-kit/index.js specifically, not merely a dist directory", () => {
    // A half-built SDK — dist present, connector-kit entry absent — is the shape a stale or
    // partial build leaves behind, and the one this guard exists to catch.
    const pkg = tmp.make("cnc-sdkhalf-");
    mkdirSync(join(pkg, "dist"), { recursive: true });

    expect(() => assertLocalSdkBuilt(pkg)).toThrow(/index\.js is missing/);
  });

  it("is a no-op in --registry mode, where there is nothing local to build", () => {
    // `undefined` is not a failure here: the published tarball either carries dist or it
    // does not, which the node_modules check inside the fixture run decides. Throwing would
    // make the registry mode — the only one that can catch `dist` missing from the
    // published `files` array — impossible to run.
    expect(() => assertLocalSdkBuilt(undefined)).not.toThrow();
  });
});

/**
 * Local-checkout mode's one edit to what the generator emitted. Both installing harnesses used to
 * make it inline, so it had never been tested; what it must not do is touch anything BUT the SDK
 * dependency, because every other byte of the package is what the harness is there to judge.
 */
describe("withLocalSdk", () => {
  beforeAll(async () => {
    await initFormatter();
  });

  /** The package.json the generator really emits for a fixture — the document the harnesses edit. */
  function emittedPackageJson(fixture: string): string {
    const spec = parseSpec(
      JSON.parse(readFileSync(join(repoRoot, "fixtures", `${fixture}.spec.json`), "utf8")),
    );
    const pkg = formatAll(generate(spec, { target: "standalone" })).find(
      (f) => displayPath(f.path) === "package.json",
    );
    if (pkg === undefined) throw new Error(`${fixture} emitted no package.json`);
    return pkg.content;
  }

  it("points the emitted SDK dependency at the local package and changes nothing else", () => {
    const emitted = emittedPackageJson("zzstandalone");
    const before = JSON.parse(emitted) as { dependencies: Record<string, string> };
    // The premise, read off the emitter rather than assumed: a standalone package declares the
    // SDK as a registry range under `dependencies`. If an emitter change ever moves it, this
    // fails here, by name, instead of the rewrite quietly adding a second declaration.
    expect(before.dependencies["@nimbus-dev/sdk"]).toMatch(/^\^\d/);

    const expected = structuredClone(before);
    expected.dependencies["@nimbus-dev/sdk"] = "file:/w/nimbus-sdk/sdks/typescript";

    // Byte equality with the input re-serialized: every other key, its value, and the order of
    // both — at the top level and inside `dependencies` — survive the edit untouched.
    expect(withLocalSdk(emitted, "/w/nimbus-sdk/sdks/typescript")).toBe(
      `${JSON.stringify(expected, undefined, 2)}\n`,
    );
  });

  it("writes the file: path with forward slashes, so a Windows checkout yields the same form", () => {
    const out = withLocalSdk(
      '{"dependencies":{"@nimbus-dev/sdk":"^2.0.0"}}',
      "C:\\w\\nimbus-sdk\\sdks\\typescript",
    );

    expect(JSON.parse(out).dependencies["@nimbus-dev/sdk"]).toBe(
      "file:C:/w/nimbus-sdk/sdks/typescript",
    );
  });

  it("re-serializes with a two-space indent and exactly one trailing newline", () => {
    const out = withLocalSdk(
      '{"name":"x","dependencies":{"zod":"^4.6.5","@nimbus-dev/sdk":"^2.0.0"},"license":"MIT"}',
      "/sdk",
    );

    expect(out).toBe(
      [
        "{",
        '  "name": "x",',
        '  "dependencies": {',
        '    "zod": "^4.6.5",',
        '    "@nimbus-dev/sdk": "file:/sdk"',
        "  },",
        '  "license": "MIT"',
        "}",
        "",
      ].join("\n"),
    );
  });

  it("refuses a document with no dependencies object, rather than rewriting it into another shape", () => {
    // An array is the case that would otherwise pass silently: assigning a string key to it is
    // legal, and JSON.stringify then drops that key, writing `"dependencies": []` back out with
    // no SDK dependency at all — an install that "succeeds" against nothing.
    for (const doc of [
      "{}",
      '{"dependencies":null}',
      '{"dependencies":[]}',
      '{"dependencies":"^2.0.0"}',
      "[]",
      "null",
    ]) {
      expect(() => withLocalSdk(doc, "/sdk"), doc).toThrow(
        "the generated package.json declares no dependencies object",
      );
    }
  });
});

describe("modeBanner", () => {
  it("names registry mode and says the generated dependency was left alone", () => {
    expect(modeBanner(undefined)).toBe(
      "Mode:        registry (@nimbus-dev/sdk resolved from npm, generated dependency unmodified)",
    );
  });

  it("names local-checkout mode and the package it will install from", () => {
    // The two modes answer different questions, and the answer is only meaningful if the
    // reader of a CI log can tell which one ran. Printing the path is what makes a run
    // against the wrong checkout visible.
    expect(modeBanner("/w/nimbus-sdk/sdks/typescript")).toBe(
      "Mode:        local checkout (/w/nimbus-sdk/sdks/typescript)",
    );
  });

  it("distinguishes the two modes", () => {
    expect(modeBanner(undefined)).not.toBe(modeBanner("/some/path"));
  });
});
