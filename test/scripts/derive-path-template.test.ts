import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { recognizePath } from "../../scripts/_lib/derive/server/path-template.ts";

function pathOf(expression: string, locals: Map<string, string> = new Map()) {
  const statement = parseModule(`const x = ${expression};`)[0]!;
  const init = (statement["declarations"] as { init: unknown }[])[0]!.init;
  return recognizePath(init as never, locals);
}

describe("recognizePath", () => {
  it("reads a static string path", () => {
    expect(pathOf('"/v2/applications.json"')).toBe("/v2/applications.json");
  });

  it("reads a template whose expression is a hoisted boolean local", () => {
    expect(pathOf("`/v2/alerts.json?only_open=${only}`", new Map([["only", "only_open"]]))).toBe(
      "/v2/alerts.json?only_open=${arg.only_open|bool}",
    );
  });

  it("reads a template whose expression is an env accessor call", () => {
    expect(pathOf("`/api/${org()}/issues/`")).toBe("/api/${env.org}/issues/");
  });

  it("returns undefined for an expression it cannot name", () => {
    expect(pathOf("`/a/${p.q.toUpperCase()}`")).toBeUndefined();
  });

  it("reads a template whose expression is a hoisted local wrapped in String() (num mode)", () => {
    expect(
      pathOf("`/api/v2/incidents?page[size]=${String(lim)}`", new Map([["lim", "limit"]])),
    ).toBe("/api/v2/incidents?page[size]=${arg.limit|num}");
  });

  it("reads a template whose expression is a hoisted local wrapped in encodeURIComponent() (enc mode)", () => {
    expect(
      pathOf(
        "`/api/search?type=dash-db&query=${encodeURIComponent(q)}`",
        new Map([["q", "query"]]),
      ),
    ).toBe("/api/search?type=dash-db&query=${arg.query|enc}");
  });

  it("reads a template whose expression is a direct, un-hoisted arg property read (raw mode)", () => {
    expect(pathOf("`/projects/${p.projectSlug}/releases/`")).toBe(
      "/projects/${arg.projectSlug}/releases/",
    );
  });

  it("recovers the full sentry issue-list path, mixing an env call, a raw arg, and a num-mode hoisted local", () => {
    expect(
      pathOf(
        "`/projects/${org()}/${p.projectSlug}/issues/?query=is:unresolved&limit=${String(lim)}`",
        new Map([["lim", "limit"]]),
      ),
    ).toBe(
      "/projects/${env.org}/${arg.projectSlug}/issues/?query=is:unresolved&limit=${arg.limit|num}",
    );
  });

  it("returns undefined when String() or encodeURIComponent() is called with the wrong arity", () => {
    expect(pathOf("`/api/${String()}`")).toBeUndefined();
    expect(pathOf("`/api/${String(a, b)}`")).toBeUndefined();
  });

  it("returns undefined for a bare identifier not present in locals", () => {
    expect(pathOf("`/api/${mystery}`")).toBeUndefined();
  });

  it("returns undefined for a non-wrapper call that takes an argument", () => {
    expect(pathOf("`/api/${org(1)}`")).toBeUndefined();
  });

  it("returns undefined for a nested member expression, e.g. p.q.r", () => {
    expect(pathOf("`/a/${p.q.r}`")).toBeUndefined();
  });

  it("returns undefined for an expression that is neither an identifier, a member expression, nor a call", () => {
    expect(pathOf("`/a/${1}`")).toBeUndefined();
  });
});
