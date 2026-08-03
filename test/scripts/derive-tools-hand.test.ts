import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";
import { recognizeTools } from "../../scripts/_lib/derive/server/tools-hand.ts";

const CONCISE = [
  'reg("newrelic_application_list", "List APM applications.", z.object({}), async () =>',
  '  jsonResult(await nrGet("/v2/applications.json")),',
  ");",
].join("\n");

const BLOCK = [
  "reg(",
  '  "newrelic_alert_violations",',
  '  "List recent alert violations.",',
  "  z.object({ only_open: z.boolean().optional() }),",
  "  async (p) => {",
  '    const only = p.only_open === true ? "true" : "false";',
  "    return jsonResult(await nrGet(`/v2/alerts_violations.json?only_open=${only}`));",
  "  },",
  ");",
].join("\n");

function run(source: string) {
  const statements = parseModule(source);
  const claims = createClaimSet();
  return {
    tools: recognizeTools(statements, claims),
    unclaimed: claims.unclaimed(statements),
    claims,
  };
}

describe("recognizeTools", () => {
  it("reads a concise-handler tool", () => {
    const { tools, unclaimed } = run(CONCISE);
    expect(tools).toEqual([
      {
        name: "newrelic_application_list",
        description: "List APM applications.",
        args: {},
        path: "/v2/applications.json",
      },
    ]);
    expect(unclaimed).toEqual([]);
  });

  it("reads a block-handler tool, recovering the hoisted boolean through the path", () => {
    const { tools } = run(BLOCK);
    expect(tools).toEqual([
      {
        name: "newrelic_alert_violations",
        description: "List recent alert violations.",
        args: { only_open: { type: "boolean", optional: true } },
        path: "/v2/alerts_violations.json?only_open=${arg.only_open|bool}",
        handlerStyle: "block",
      },
    ]);
  });

  it("reads several tools in declaration order", () => {
    const { tools } = run(`${CONCISE}\n${BLOCK}`);
    expect(tools?.map((t) => t.name)).toEqual([
      "newrelic_application_list",
      "newrelic_alert_violations",
    ]);
  });

  it("fails the whole connector when one reg call is not understood", () => {
    const source = `${CONCISE}\nreg("x", "y", z.object({}), customHandler);`;
    const { tools, unclaimed } = run(source);
    expect(tools).toBeUndefined();
    expect(unclaimed).toHaveLength(2);
  });

  it("returns an empty list for a module with no reg calls", () => {
    expect(run("const a = 1;").tools).toEqual([]);
  });

  it("refuses a conditional that is not the boolean hoist, rather than claiming it wrongly", () => {
    const source = [
      "reg(",
      '  "t",',
      '  "d",',
      "  z.object({ limit: z.number().optional() }),",
      "  async (p) => {",
      '    const mode = p.limit === 0 ? "a" : "b";',
      "    return jsonResult(await nrGet(`/x?m=${mode}`));",
      "  },",
      ");",
    ].join("\n");
    expect(run(source).tools).toBeUndefined();
  });

  it("recognizes a hoisted default-value local (bool: false) through the path, not just the boolean form", () => {
    const source = [
      "reg(",
      '  "zzwrite_item_create",',
      '  "Create item.",',
      "  z.object({ scope: z.string().optional() }),",
      "  async (p) => {",
      '    const scope = p.scope ?? "all";',
      '    return jsonResult(await writeSend(`/v1/items?scope=${scope}`, "POST", undefined));',
      "  },",
      ");",
    ].join("\n");
    const { tools } = run(source);
    expect(tools).toEqual([
      {
        name: "zzwrite_item_create",
        description: "Create item.",
        args: { scope: { type: "string", optional: true } },
        path: "/v1/items?scope=${arg.scope}",
        handlerStyle: "block",
      },
    ]);
  });

  it("refuses a hoist whose right-hand side of === is not literal true, rather than mis-reading it as the boolean form", () => {
    const source = [
      "reg(",
      '  "t",',
      '  "d",',
      "  z.object({ only_open: z.boolean().optional() }),",
      "  async (p) => {",
      '    const only = p.only_open === false ? "true" : "false";',
      "    return jsonResult(await nrGet(`/x?o=${only}`));",
      "  },",
      ");",
    ].join("\n");
    expect(run(source).tools).toBeUndefined();
  });

  it("refuses a hoist using || instead of the exact ?? default form", () => {
    const source = [
      "reg(",
      '  "t",',
      '  "d",',
      "  z.object({ scope: z.string().optional() }),",
      "  async (p) => {",
      '    const scope = p.scope || "all";',
      "    return jsonResult(await nrGet(`/x?s=${scope}`));",
      "  },",
      ");",
    ].join("\n");
    expect(run(source).tools).toBeUndefined();
  });

  it("refuses a reg(...) call with a fifth argument, rather than reading only the first four", () => {
    const source =
      'reg("t", "d", z.object({}), async () => jsonResult(await nrGet("/x")), "extra");';
    const { tools, claims } = run(source);
    expect(tools).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("refuses a reg(...) call missing its handler argument (three arguments), rather than reading a partial call", () => {
    const source = 'reg("t", "d", z.object({}));';
    const { tools, claims } = run(source);
    expect(tools).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("refuses a block handler with no statements at all, rather than treating it as an empty-but-valid body", () => {
    const source = ["reg(", '  "t",', '  "d",', "  z.object({}),", "  async (p) => {},", ");"].join(
      "\n",
    );
    const { tools, claims } = run(source);
    expect(tools).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("refuses a hoist position statement declaring more than one variable, e.g. const a = 1, b = 2;", () => {
    const source = [
      "reg(",
      '  "t",',
      '  "d",',
      "  z.object({ only_open: z.boolean().optional() }),",
      "  async (p) => {",
      "    const a = 1, b = 2;",
      "    return jsonResult(await nrGet(`/x`));",
      "  },",
      ");",
    ].join("\n");
    const { tools, claims } = run(source);
    expect(tools).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("refuses a hoist position statement whose declarator id is a destructuring pattern, not a plain identifier", () => {
    const source = [
      "reg(",
      '  "t",',
      '  "d",',
      "  z.object({ only_open: z.boolean().optional() }),",
      "  async (p) => {",
      "    const { only_open } = p;",
      "    return jsonResult(await nrGet(`/x`));",
      "  },",
      ");",
    ].join("\n");
    const { tools, claims } = run(source);
    expect(tools).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("does not recognize a reg(...) call reached through a member expression, e.g. obj.reg(...)", () => {
    // isRegCall requires an Identifier callee named "reg" — a member-expression callee is a
    // different shape (and not one renderTool ever emits), so the statement is simply not a
    // reg call at all: it is skipped rather than fed to recognizeOne, tools is the successful
    // (but empty) result, and the statement itself is left unclaimed.
    const source = 'obj.reg("t", "d", z.object({}), async () => jsonResult(await nrGet("/x")));';
    const { tools, unclaimed } = run(source);
    expect(tools).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });

  it("refuses a handler whose jsonResult(...) call has more than one argument, rather than reading only the first", () => {
    const source =
      'reg("t", "d", z.object({}), async () => jsonResult(await nrGet("/x"), "extra"));';
    const { tools, claims } = run(source);
    expect(tools).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });
});
