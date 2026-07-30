import { describe, expect, it } from "bun:test";
import { parsePathTemplate, renderPath } from "../../../src/emit/server/path-template.ts";

const noHoists = { param: "p", hoisted: new Map<string, string>() };

describe("parsePathTemplate", () => {
  it("returns a single literal when there are no placeholders", () => {
    expect(parsePathTemplate("/v2/applications.json")).toEqual([
      { kind: "literal", text: "/v2/applications.json" },
    ]);
  });

  it("parses env and arg placeholders with modes", () => {
    expect(parsePathTemplate("/p/${env.org}/${arg.slug}/x?l=${arg.limit|num}")).toEqual([
      { kind: "literal", text: "/p/" },
      { kind: "env", name: "org" },
      { kind: "literal", text: "/" },
      { kind: "arg", name: "slug", mode: "raw" },
      { kind: "literal", text: "/x?l=" },
      { kind: "arg", name: "limit", mode: "num" },
    ]);
  });

  it("rejects an unknown mode", () => {
    expect(() => parsePathTemplate("/x/${arg.a|nope}")).toThrow(/nope/);
  });

  it("rejects an unknown namespace", () => {
    expect(() => parsePathTemplate("/x/${cfg.a}")).toThrow(/cfg/);
  });
});

describe("renderPath", () => {
  it("renders a plain quoted string when there are no placeholders", () => {
    expect(renderPath(parsePathTemplate("/api/v1/monitor"), noHoists)).toBe('"/api/v1/monitor"');
  });

  it("renders env placeholders as accessor calls", () => {
    const out = renderPath(parsePathTemplate("/projects/${env.org}/releases/"), noHoists);
    expect(out).toBe("`/projects/${org()}/releases/`");
  });

  it("renders a non-hoisted arg via the handler param", () => {
    const out = renderPath(parsePathTemplate("/g/${arg.slug}/c"), noHoists);
    expect(out).toBe("`/g/${p.slug}/c`");
  });

  it("wraps num and enc modes", () => {
    const hoisted = new Map([["limit", "lim"]]);
    expect(renderPath(parsePathTemplate("?l=${arg.limit|num}"), { param: "p", hoisted })).toBe(
      "`?l=${String(lim)}`",
    );
    expect(renderPath(parsePathTemplate("?q=${arg.query|enc}"), noHoists)).toBe(
      "`?q=${encodeURIComponent(p.query)}`",
    );
  });

  it("renders a hoisted boolean as the bare local", () => {
    const hoisted = new Map([["only_open", "only"]]);
    expect(renderPath(parsePathTemplate("?o=${arg.only_open|bool}"), { param: "p", hoisted })).toBe(
      "`?o=${only}`",
    );
  });
});
