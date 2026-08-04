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
    expect(() => parsePathTemplate("/x/${env.a}/${arg.b|ENC}")).toThrow(
      /Malformed placeholder in path template: "\/\$\{arg\.b\|ENC\}"/,
    );
  });

  it("rejects incomplete arg placeholder without dot", () => {
    expect(() => parsePathTemplate("/x/${env.a}/${arg}")).toThrow(
      /Malformed placeholder in path template: "\/\$\{arg\}"/,
    );
  });

  it("rejects uppercase namespace", () => {
    expect(() => parsePathTemplate("/x/${env.a}/${ARG.b}")).toThrow(
      /Malformed placeholder in path template: "\/\$\{ARG\.b\}"/,
    );
  });

  it("rejects unterminated placeholder", () => {
    expect(() => parsePathTemplate("/x/${env.a}/${arg.b")).toThrow(
      /Malformed placeholder in path template: "\/\$\{arg\.b"/,
    );
  });

  // These two are the only failure mode here that is SILENT. An unterminated or
  // wrong-namespace placeholder already throws; `{id}` and `/:id` used to pass straight
  // through as literal text, emitting a connector that compiles, typechecks, passes every
  // gate in this repo, and then requests a URL containing the characters "{id}".
  it("rejects OpenAPI-style {id}, naming the replacement", () => {
    expect(() => parsePathTemplate("/items/{id}")).toThrow(
      /uses \{id\}, which this generator does not interpolate/,
    );
    expect(() => parsePathTemplate("/items/{id}")).toThrow(/Use \$\{arg\.id\|enc\} instead/);
  });

  it("rejects Express-style /:id, naming the replacement", () => {
    expect(() => parsePathTemplate("/items/:id")).toThrow(
      /uses \/:id, which this generator does not interpolate/,
    );
    expect(() => parsePathTemplate("/items/:id")).toThrow(/Use \$\{arg\.id\|enc\} instead/);
  });

  // The Express arm matches "/:" and not a bare colon, because a colon inside a query value
  // is ordinary. This exact path is sentry's, one of the four byte-locked golden fixtures:
  // if this ever throws, `diff:golden` drops sentry from 6/6 and the corpus stops
  // reproducing.
  it("accepts a colon inside a query value — is:unresolved is not a placeholder", () => {
    const tpl = "/projects/${env.org}/${arg.projectSlug}/issues/?query=is:unresolved";
    expect(() => parsePathTemplate(tpl)).not.toThrow();
    expect(parsePathTemplate(tpl).some((s) => s.kind === "arg")).toBe(true);
  });

  it("accepts a bracketed query key — page[size] is not a placeholder", () => {
    // datadog's fixture path. Square brackets, not braces; the guard must not widen to them.
    expect(() => parsePathTemplate("/api/v2/incidents?page[size]=${arg.limit|num}")).not.toThrow();
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

  it("|bool contributes nothing beyond the hoist — identical to |raw once hoisted (F7)", () => {
    // Pins the actual behaviour: the "true"/"false" conversion comes entirely from
    // renderHoists (keyed on type === "boolean"), never from this placeholder mode —
    // argExpression's `bool` case falls through to the same code path as `raw`. Restricting
    // |bool to boolean-typed args is enforced at validation (validateSpec), not here, since
    // renderPath has no notion of an arg's declared type.
    const hoisted = new Map([["only_open", "only"]]);
    const bool = renderPath(parsePathTemplate("?o=${arg.only_open|bool}"), { param: "p", hoisted });
    const raw = renderPath(parsePathTemplate("?o=${arg.only_open|raw}"), { param: "p", hoisted });
    expect(bool).toBe(raw);
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

  describe("staticStyle", () => {
    it("renders a static path as a backtick template literal when staticStyle is 'template'", () => {
      const out = renderPath(parsePathTemplate("/api/v1/accounts"), {
        ...noHoists,
        staticStyle: "template",
      });
      expect(out).toBe("`/api/v1/accounts`");
    });

    it("still quotes a static path when staticStyle is 'quoted'", () => {
      const out = renderPath(parsePathTemplate("/api/v1/accounts"), {
        ...noHoists,
        staticStyle: "quoted",
      });
      expect(out).toBe('"/api/v1/accounts"');
    });

    it("escapes backslashes and backticks the same way the dynamic branch does", () => {
      const out = renderPath(parsePathTemplate("/path\\with`both"), {
        ...noHoists,
        staticStyle: "template",
      });
      expect(out).toBe("`/path\\\\with\\`both`");
    });

    it("has no effect on a dynamic path — it is already a template literal either way", () => {
      const quoted = renderPath(parsePathTemplate("/g/${arg.slug}/c"), {
        ...noHoists,
        staticStyle: "quoted",
      });
      const templated = renderPath(parsePathTemplate("/g/${arg.slug}/c"), {
        ...noHoists,
        staticStyle: "template",
      });
      expect(quoted).toBe("`/g/${p.slug}/c`");
      expect(templated).toBe("`/g/${p.slug}/c`");
    });

    it("defaults to the quoted form when staticStyle is omitted", () => {
      expect(renderPath(parsePathTemplate("/api/v1/monitor"), noHoists)).toBe('"/api/v1/monitor"');
    });
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
