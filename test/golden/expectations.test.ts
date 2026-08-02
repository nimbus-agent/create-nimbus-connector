import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, loadExpectations } from "../../src/golden/expectations.ts";
import { tempDirs } from "../support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

const SIX = [
  "README.md",
  "nimbus.extension.json",
  "package.json",
  "src/server.ts",
  "test/sandbox.test.ts",
  "tsconfig.json",
];

describe("classify", () => {
  it("passes when the same set of files matched, whatever the order", () => {
    expect(classify(SIX, SIX).verdict).toBe("pass");
    expect(classify([...SIX].reverse(), SIX).verdict).toBe("pass");
    expect(classify([], []).verdict).toBe("pass");
  });

  it("reports a regression when a declared file stopped matching", () => {
    const c = classify(["README.md"], ["README.md", "tsconfig.json"]);
    expect(c.verdict).toBe("regressed");
    expect(c.lost).toEqual(["tsconfig.json"]);
    expect(c.gained).toEqual([]);
  });

  it("reports an improvement when an undeclared file started matching — still not a pass", () => {
    const c = classify(["README.md", "tsconfig.json"], ["README.md"]);
    expect(c.verdict).toBe("improved");
    expect(c.gained).toEqual(["tsconfig.json"]);
    expect(c.lost).toEqual([]);
  });

  it("catches a count-preserving swap, which a count comparison reported as PASS", () => {
    // This is the false-green hole the set comparison exists to close: for a partial
    // fixture such as discord (3 of 6), newly matching README.md while breaking
    // package.json leaves the count at 3.
    const c = classify(
      ["README.md", "test/sandbox.test.ts", "tsconfig.json"],
      ["package.json", "test/sandbox.test.ts", "tsconfig.json"],
    );
    expect(c.verdict).toBe("changed");
    expect(c.lost).toEqual(["package.json"]);
    expect(c.gained).toEqual(["README.md"]);
  });

  it("distinguishes regressed from improved rather than collapsing both to a failure", () => {
    const below = classify(["a"], ["a", "b"]).verdict;
    const above = classify(["a", "b"], ["a"]).verdict;
    expect(below).not.toBe(above);
    expect(below).toBe("regressed");
    expect(above).toBe("improved");
  });

  it("sorts lost and gained so a failure line is stable across runs", () => {
    const c = classify(["z", "a"], ["y", "b"]);
    expect(c.gained).toEqual(["a", "z"]);
    expect(c.lost).toEqual(["b", "y"]);
  });
});

function writeExpectations(content: string): string {
  const dir = tmp.make("expectations-");
  const path = join(dir, "expectations.json");
  writeFileSync(path, content);
  return path;
}

describe("loadExpectations", () => {
  it("parses a well-formed expectations file", () => {
    const path = writeExpectations('{"newrelic": ["README.md"], "discord": []}');
    expect(loadExpectations(path)).toEqual({ newrelic: ["README.md"], discord: [] });
  });

  it("throws when the file does not exist", () => {
    expect(() => loadExpectations(join(tmpdir(), "definitely-not-a-file.json"))).toThrow(
      /could not read/i,
    );
  });

  it("throws on unparseable JSON", () => {
    const path = writeExpectations("{ not json");
    expect(() => loadExpectations(path)).toThrow(/could not parse/i);
  });

  it("throws when the top-level value is not an object", () => {
    const path = writeExpectations("[1, 2, 3]");
    expect(() => loadExpectations(path)).toThrow(/must be a JSON object/i);
  });

  it("rejects the old count shape rather than silently reinterpreting it", () => {
    // A stale `{"discord": 3}` must not load as anything — 3 is not a set of paths, and
    // guessing would resurrect exactly the comparison this shape replaced.
    expect(() => loadExpectations(writeExpectations('{"discord": 3}'))).toThrow(/discord/);
  });

  it("throws when a value is not an array of non-empty strings", () => {
    expect(() => loadExpectations(writeExpectations('{"discord": "README.md"}'))).toThrow(
      /discord/,
    );
    expect(() => loadExpectations(writeExpectations('{"discord": [1]}'))).toThrow(/discord/);
    expect(() => loadExpectations(writeExpectations('{"discord": [""]}'))).toThrow(/discord/);
  });

  it("throws on a duplicated path, which would make the declared set ambiguous", () => {
    expect(() => loadExpectations(writeExpectations('{"discord": ["a.md", "a.md"]}'))).toThrow(
      /duplicate/i,
    );
  });
});

describe("the checked-in fixtures/expectations.json", () => {
  it("loads under the current shape and declares every checked-in fixture", () => {
    const loaded = loadExpectations(
      join(import.meta.dir, "..", "..", "fixtures", "expectations.json"),
    );
    expect(Object.keys(loaded).sort()).toEqual([
      "bitrise",
      "datadog",
      "dependencytrack",
      "discord",
      "google-meet",
      "grafana",
      "mercury",
      "newrelic",
      "sentry",
      "zendesk",
      "zzscratch",
      "zzsearch",
      "zzsearchstub",
      "zzstandalone",
      "zzstandalonehand",
      "zzwrite",
      "zzwriteonly",
      "zzwriterest",
    ]);
    // The two partial fixtures are the reason the shape changed; assert their sets, not
    // their sizes, so a count-preserving swap fails here too.
    expect([...loaded.discord!].sort()).toEqual([
      "README.md",
      "test/sandbox.test.ts",
      "tsconfig.json",
    ]);
    expect([...loaded["google-meet"]!].sort()).toEqual([
      "nimbus.extension.json",
      "test/sandbox.test.ts",
    ]);
  });
});
