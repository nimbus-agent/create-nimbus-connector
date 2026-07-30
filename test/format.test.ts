import { describe, expect, it } from "bun:test";
import { biomeVersion, formatAll } from "../src/format.ts";

describe("formatAll", () => {
  it("formats TypeScript to the Nimbus house style", () => {
    const [out] = formatAll([{ path: ["src", "server.ts"], content: "const x = {a:1,b:2}\n" }]);
    expect(out?.content).toBe("const x = { a: 1, b: 2 };\n");
  });

  it("leaves non-TypeScript files untouched", () => {
    const input = { path: ["README.md"], content: "#   Title\n\n\n" };
    const [out] = formatAll([input]);
    expect(out?.content).toBe(input.content);
  });

  it("preserves object expansion chosen by the emitter", () => {
    const expanded = "const r = await fetch(u, {\n  headers: h(),\n});\n";
    const inline = "const r = await fetch(u, { headers: h() });\n";
    const [a, b] = formatAll([
      { path: ["a.ts"], content: expanded },
      { path: ["b.ts"], content: inline },
    ]);
    expect(a?.content).toBe(expanded);
    expect(b?.content).toBe(inline);
  });

  it("breaks lines longer than 100 columns", () => {
    const long = `const value = someFunction(${"argument, ".repeat(12)}last);\n`;
    const [out] = formatAll([{ path: ["c.ts"], content: long }]);
    expect(out?.content.split("\n").every((l) => l.length <= 100)).toBe(true);
  });

  it("round-trips a newrelic-shaped concise-arrow registration unchanged", () => {
    const reg =
      'reg("newrelic_application_list", "List APM applications.", z.object({}), async () =>\n' +
      '  jsonResult(await nrGet("/v2/applications.json")),\n);\n';
    expect(formatAll([{ path: ["d.ts"], content: reg }])[0]?.content).toBe(reg);
  });

  it("throws when fed syntactically invalid TypeScript, including the file path in the error", () => {
    const broken = "const x = {a:1,,,;\nfunction (((\n";
    expect(() => {
      formatAll([{ path: ["src", "server.ts"], content: broken }]);
    }).toThrow(/src\/server\.ts/);
  });

  it("formats valid code with no error diagnostics normally", () => {
    const valid = "const x: number = 42;\n";
    const [out] = formatAll([{ path: ["valid.ts"], content: valid }]);
    expect(out?.content).toBeDefined();
  });

  it("collapses a short JSON array onto one line", () => {
    const input = JSON.stringify({ a: ["x", "y"] }, undefined, 2);
    const [out] = formatAll([{ path: ["nimbus.extension.json"], content: input }]);
    expect(out?.content).toBe('{\n  "a": ["x", "y"]\n}\n');
  });

  it("keeps a JSON array expanded when it does not fit within 100 columns", () => {
    const items = Array.from({ length: 12 }, (_, i) => `"a-rather-long-array-item-${i}"`);
    const input = `{"network":[${items.join(",")}]}`;
    const [out] = formatAll([{ path: ["nimbus.extension.json"], content: input }]);
    expect(out?.content).toContain("[\n");
    expect(out?.content.split("\n").every((l) => l.length <= 100)).toBe(true);
  });

  it("leaves README.md untouched (regression guard for the pass-through path)", () => {
    const input = { path: ["README.md"], content: "#   Title\n\n\n" };
    const [out] = formatAll([input]);
    expect(out?.content).toBe(input.content);
  });

  it("throws when fed syntactically invalid JSON, including the file path in the error", () => {
    const broken = '{ "a": [1, 2,,, }';
    expect(() => {
      formatAll([{ path: ["nimbus.extension.json"], content: broken }]);
    }).toThrow(/nimbus\.extension\.json/);
  });
});

describe("biomeVersion", () => {
  it("reports the resolved backend version", () => {
    expect(biomeVersion()).toMatch(/^2\.5\./);
  });
});
