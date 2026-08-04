import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";
import { recognizeTools } from "../../scripts/_lib/derive/server/tools-hand.ts";

const CONCISE = [
  'reg("newrelic_application_list", "List APM applications.", z.object({}), async () =>',
  '  jsonResult(await nrGet("/v2/applications.json")),',
  ");",
].join("\n");

// Block WITH a hoist — forced into block form regardless of the connector's handlerStyle, so
// on its own this is NOT evidence of handlerStyle: "block". See BLOCK_NO_HOIST below for the
// shape that actually is.
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

// Block with NO hoist — src/emit/server/tools-hand.ts's renderTool only takes the block form
// with zero hoists when spec.handlerStyle is explicitly "block" (a "concise" connector would
// have rendered this same tool as the one-line form instead). This is the discriminating shape.
const BLOCK_NO_HOIST = [
  "reg(",
  '  "newrelic_ping",',
  '  "Ping the API.",',
  "  z.object({}),",
  "  async () => {",
  '    return jsonResult(await nrGet("/v2/ping.json"));',
  "  },",
  ");",
].join("\n");

function run(source: string) {
  const statements = parseModule(source);
  const claims = createClaimSet();
  return {
    result: recognizeTools(statements, claims),
    unclaimed: claims.unclaimed(statements),
    claims,
  };
}

describe("recognizeTools", () => {
  it("reads a concise-handler tool, with no per-tool handlerStyle and no connector-level one", () => {
    const { result, unclaimed } = run(CONCISE);
    expect(result).toEqual({
      tools: [
        {
          name: "newrelic_application_list",
          description: "List APM applications.",
          args: {},
          path: "/v2/applications.json",
        },
      ],
    });
    expect(unclaimed).toEqual([]);
  });

  it("reads a block-with-hoist tool, recovering the hoisted boolean and its local name through the path, without inferring handlerStyle", () => {
    const { result } = run(BLOCK);
    // A block body forced by a hoist is not evidence of handlerStyle: "block" — see the BLOCK
    // constant's comment — so the connector-level field stays omitted, and the per-tool
    // ToolFields carries no handlerStyle at all (it is not a schema field on a tool).
    // Gap A: the hoist statement names its own const "only", which differs from the arg's own
    // key "only_open" — renderHoists writes `a.local ?? name`, so that's `local: "only"`.
    expect(result).toEqual({
      tools: [
        {
          name: "newrelic_alert_violations",
          description: "List recent alert violations.",
          args: { only_open: { type: "boolean", optional: true, local: "only" } },
          path: "/v2/alerts_violations.json?only_open=${arg.only_open|bool}",
        },
      ],
    });
  });

  it("reads several tools in declaration order", () => {
    const { result } = run(`${CONCISE}\n${BLOCK}`);
    expect(result?.tools.map((t) => t.name)).toEqual([
      "newrelic_application_list",
      "newrelic_alert_violations",
    ]);
  });

  it("fails the whole connector when one reg call is not understood", () => {
    const source = `${CONCISE}\nreg("x", "y", z.object({}), customHandler);`;
    const { result, unclaimed } = run(source);
    expect(result).toBeUndefined();
    expect(unclaimed).toHaveLength(2);
  });

  it("returns an empty list for a module with no reg calls", () => {
    expect(run("const a = 1;").result).toEqual({ tools: [] });
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
    expect(run(source).result).toBeUndefined();
  });

  it("recognizes a hoisted default-value local (bool: false) through the path, recovering the default literal (Gap B)", () => {
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
    const { result } = run(source);
    // The hoist's own const name is "scope", same as the arg's key, so no `local` is fed
    // back (Gap A only applies when the two differ) — but the `??` right-hand side "all" is
    // otherwise unrecoverable (renderZodSchema never encodes it), so `default` always is.
    expect(result).toEqual({
      tools: [
        {
          name: "zzwrite_item_create",
          description: "Create item.",
          args: { scope: { type: "string", optional: true, default: "all" } },
          path: "/v1/items?scope=${arg.scope}",
        },
      ],
    });
  });

  it("recognizes a numeric default literal (the real datadog_incident_list / sentry_issue_list shape)", () => {
    const source = [
      "reg(",
      '  "datadog_incident_list",',
      '  "List incidents.",',
      "  z.object({ limit: z.number().int().min(1).max(50).optional() }),",
      "  async (p) => {",
      "    const lim = p.limit ?? 10;",
      "    return jsonResult(await ddGet(`/api/v2/incidents?page[size]=${String(lim)}`));",
      "  },",
      ");",
    ].join("\n");
    const { result } = run(source);
    expect(result).toEqual({
      tools: [
        {
          name: "datadog_incident_list",
          description: "List incidents.",
          args: {
            limit: {
              type: "number",
              int: true,
              min: 1,
              max: 50,
              optional: true,
              default: 10,
              local: "lim",
            },
          },
          path: "/api/v2/incidents?page[size]=${arg.limit|num}",
        },
      ],
    });
  });

  it("refuses a ?? hoist whose right-hand side is not a string/number/boolean literal, rather than guessing a default", () => {
    const source = [
      "reg(",
      '  "t",',
      '  "d",',
      "  z.object({ scope: z.string().optional() }),",
      "  async (p) => {",
      "    const scope = p.scope ?? fallbackScope();",
      "    return jsonResult(await nrGet(`/x?s=${scope}`));",
      "  },",
      ");",
    ].join("\n");
    const { result, claims } = run(source);
    expect(result).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("refuses a hoist naming an arg the z.object({...}) schema does not declare", () => {
    const source = [
      "reg(",
      '  "t",',
      '  "d",',
      "  z.object({ other: z.string().optional() }),",
      "  async (p) => {",
      '    const scope = p.scope ?? "all";',
      "    return jsonResult(await nrGet(`/x?s=${scope}`));",
      "  },",
      ");",
    ].join("\n");
    const { result, claims } = run(source);
    expect(result).toBeUndefined();
    expect(claims.claims()).toEqual([]);
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
    expect(run(source).result).toBeUndefined();
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
    expect(run(source).result).toBeUndefined();
  });

  it("refuses a reg(...) call with a fifth argument, rather than reading only the first four", () => {
    const source =
      'reg("t", "d", z.object({}), async () => jsonResult(await nrGet("/x")), "extra");';
    const { result, claims } = run(source);
    expect(result).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("refuses a reg(...) call missing its handler argument (three arguments), rather than reading a partial call", () => {
    const source = 'reg("t", "d", z.object({}));';
    const { result, claims } = run(source);
    expect(result).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("refuses a block handler with no statements at all, rather than treating it as an empty-but-valid body", () => {
    const source = ["reg(", '  "t",', '  "d",', "  z.object({}),", "  async (p) => {},", ");"].join(
      "\n",
    );
    const { result, claims } = run(source);
    expect(result).toBeUndefined();
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
    const { result, claims } = run(source);
    expect(result).toBeUndefined();
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
    const { result, claims } = run(source);
    expect(result).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("does not recognize a reg(...) call reached through a member expression, e.g. obj.reg(...)", () => {
    // isRegCall requires an Identifier callee named "reg" — a member-expression callee is a
    // different shape (and not one renderTool ever emits), so the statement is simply not a
    // reg call at all: it is skipped rather than fed to recognizeOne, tools is the successful
    // (but empty) result, and the statement itself is left unclaimed.
    const source = 'obj.reg("t", "d", z.object({}), async () => jsonResult(await nrGet("/x")));';
    const { result, unclaimed } = run(source);
    expect(result).toEqual({ tools: [] });
    expect(unclaimed).toHaveLength(1);
  });

  it("refuses a handler whose jsonResult(...) call has more than one argument, rather than reading only the first", () => {
    const source =
      'reg("t", "d", z.object({}), async () => jsonResult(await nrGet("/x"), "extra"));';
    const { result, claims } = run(source);
    expect(result).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  // --- Connector-level handlerStyle recovery (see recognizeTools's docstring for the rule).

  it("derives handlerStyle: block from a single block-with-no-hoists tool", () => {
    const { result } = run(BLOCK_NO_HOIST);
    expect(result).toEqual({
      tools: [
        {
          name: "newrelic_ping",
          description: "Ping the API.",
          args: {},
          path: "/v2/ping.json",
        },
      ],
      handlerStyle: "block",
    });
  });

  it("omits handlerStyle for a mix of concise and block-with-hoists tools (the real newrelic/datadog/grafana/sentry shape)", () => {
    const { result } = run(`${CONCISE}\n${BLOCK}`);
    expect(result?.handlerStyle).toBeUndefined();
  });

  it("omits handlerStyle when every tool is block-with-hoists (ambiguous, but both settings regenerate identical bytes)", () => {
    const { result } = run(BLOCK);
    expect(result?.handlerStyle).toBeUndefined();
  });

  it("rejects a connector mixing a concise tool with a block-without-hoists tool — no single handlerStyle explains both", () => {
    const { result, unclaimed } = run(`${CONCISE}\n${BLOCK_NO_HOIST}`);
    expect(result).toBeUndefined();
    // Neither reg() call is claimed once the pair is rejected — see recognizeTools: the claim
    // happens only after the mixed-shape check passes.
    expect(unclaimed).toHaveLength(2);
  });

  it("derives handlerStyle: block for a mix of block-with-hoists and block-without-hoists tools", () => {
    const { result } = run(`${BLOCK}\n${BLOCK_NO_HOIST}`);
    expect(result?.handlerStyle).toBe("block");
    expect(result?.tools.map((t) => t.name)).toEqual([
      "newrelic_alert_violations",
      "newrelic_ping",
    ]);
  });
});
