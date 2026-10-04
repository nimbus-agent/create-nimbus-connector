/**
 * Unit tests for the write half `bun run schema` and `bun run build:spec-doc` share.
 *
 * Small, and the one claim worth a test is the number it prints: both drivers used to report
 * `text.length` as "bytes", which is true only for ASCII. docs/SPEC.md is not ASCII.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeGenerated } from "../../scripts/_lib/write-generated.ts";
import { tempDirs } from "../support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

describe("writeGenerated", () => {
  it("writes the text exactly, creating the directories it needs", () => {
    const path = join(tmp.make("cnc-writegen-"), "docs", "nested", "SPEC.md");

    writeGenerated(path, "# Spec\n\nline two\n");

    expect(readFileSync(path, "utf8")).toBe("# Spec\n\nline two\n");
  });

  it("reports the size in UTF-8 bytes — the size on disk — not in UTF-16 code units", () => {
    const path = join(tmp.make("cnc-writegen-"), "out.md");
    // "—" is one code unit and three bytes, so this text is 9 code units and 11 bytes.
    const text = "— a dash\n";

    const line = writeGenerated(path, text);

    expect(line).toBe(`Wrote ${path} (11 bytes)`);
    expect(statSync(path).size).toBe(11);
  });

  it("replaces an existing file rather than appending to it", () => {
    const path = join(tmp.make("cnc-writegen-"), "schema.json");
    writeFileSync(path, "a much longer previous version of the document\n", "utf8");

    writeGenerated(path, "{}\n");

    expect(readFileSync(path, "utf8")).toBe("{}\n");
  });
});
