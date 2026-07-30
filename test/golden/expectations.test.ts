import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, loadExpectations } from "../../src/golden/expectations.ts";

describe("classify", () => {
  it("passes when actual equals expected", () => {
    expect(classify(6, 6)).toBe("pass");
    expect(classify(3, 3)).toBe("pass");
    expect(classify(0, 0)).toBe("pass");
  });

  it("reports a regression when actual is below expected", () => {
    expect(classify(2, 3)).toBe("regressed");
    expect(classify(0, 6)).toBe("regressed");
  });

  it("reports an improvement when actual is above expected — still not a pass", () => {
    expect(classify(4, 3)).toBe("improved");
    expect(classify(6, 0)).toBe("improved");
  });

  it("distinguishes regressed from improved rather than collapsing both to a generic failure", () => {
    const below = classify(2, 3);
    const above = classify(4, 3);
    expect(below).not.toBe(above);
    expect(below).toBe("regressed");
    expect(above).toBe("improved");
  });
});

function writeExpectations(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "expectations-"));
  const path = join(dir, "expectations.json");
  writeFileSync(path, content);
  return path;
}

describe("loadExpectations", () => {
  it("parses a well-formed expectations file", () => {
    const path = writeExpectations('{"newrelic": 6, "discord": 3}');
    expect(loadExpectations(path)).toEqual({ newrelic: 6, discord: 3 });
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

  it("throws when a value is not a non-negative integer", () => {
    expect(() => loadExpectations(writeExpectations('{"discord": "3"}'))).toThrow(/discord/);
    expect(() => loadExpectations(writeExpectations('{"discord": -1}'))).toThrow(/discord/);
    expect(() => loadExpectations(writeExpectations('{"discord": 2.5}'))).toThrow(/discord/);
  });
});
