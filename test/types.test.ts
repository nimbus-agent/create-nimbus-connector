import { describe, expect, it } from "bun:test";
import { displayPath } from "../src/types.ts";

describe("displayPath", () => {
  it("joins segments with forward slashes regardless of platform", () => {
    expect(displayPath(["src", "server.ts"])).toBe("src/server.ts");
  });

  it("handles a single segment", () => {
    expect(displayPath(["README.md"])).toBe("README.md");
  });
});
