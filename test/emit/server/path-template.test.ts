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

  it("rejects env placeholder with a mode", () => {
    expect(() => parsePathTemplate("/x/${env.a|enc}")).toThrow(/cannot take a mode/);
  });

  it("rejects uppercase mode name", () => {
    expect(() => parsePathTemplate("/x/${env.a}/${arg.b|ENC}")).toThrow(/Malformed placeholder/);
  });

  it("rejects incomplete arg placeholder without dot", () => {
    expect(() => parsePathTemplate("/x/${env.a}/${arg}")).toThrow(/Malformed placeholder/);
  });

  it("rejects uppercase namespace", () => {
    expect(() => parsePathTemplate("/x/${env.a}/${ARG.b}")).toThrow(/Malformed placeholder/);
  });

  it("rejects unterminated placeholder", () => {
    expect(() => parsePathTemplate("/x/${env.a}/${arg.b")).toThrow(/Malformed placeholder/);
  });

  it("returns empty array for empty template", () => {
    expect(parsePathTemplate("")).toEqual([]);
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

  it("renders empty template as empty quoted string", () => {
    expect(renderPath([], noHoists)).toBe('""');
  });

  it("escapes backslashes in literal segments", () => {
    const out = renderPath(parsePathTemplate("/path\\with\\backslashes/${arg.x}"), noHoists);
    expect(out).toBe("`/path\\\\with\\\\backslashes/${p.x}`");
  });

  it("escapes backticks in literal segments", () => {
    const out = renderPath(parsePathTemplate("/path`with`backticks/${arg.x}"), noHoists);
    expect(out).toBe("`/path\\`with\\`backticks/${p.x}`");
  });

  it("renders /v2/applications.json without placeholders", () => {
    expect(renderPath(parsePathTemplate("/v2/applications.json"), noHoists)).toBe(
      '"/v2/applications.json"',
    );
  });

  it("renders incident template with square brackets and hoisted num mode", () => {
    const hoisted = new Map([["limit", "lim"]]);
    expect(
      renderPath(parsePathTemplate("/api/v2/incidents?page[size]=${arg.limit|num}"), {
        param: "p",
        hoisted,
      }),
    ).toBe("`/api/v2/incidents?page[size]=${String(lim)}`");
  });

  it("renders project issues template with multiple placeholders and hoisted limit", () => {
    const hoisted = new Map([["limit", "lim"]]);
    expect(
      renderPath(
        parsePathTemplate(
          "/projects/${env.org}/${arg.projectSlug}/issues/?query=is:unresolved&limit=${arg.limit|num}",
        ),
        { param: "p", hoisted },
      ),
    ).toBe(
      "`/projects/${org()}/${p.projectSlug}/issues/?query=is:unresolved&limit=${String(lim)}`",
    );
  });

  it("renders search template with enc mode and hoisted query", () => {
    const hoisted = new Map([["query", "q"]]);
    expect(
      renderPath(parsePathTemplate("/api/search?type=dash-db&query=${arg.query|enc}"), {
        param: "p",
        hoisted,
      }),
    ).toBe("`/api/search?type=dash-db&query=${encodeURIComponent(q)}`");
  });
});
