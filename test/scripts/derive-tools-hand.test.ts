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

  it("refuses a module with no reg calls, rather than falsely deriving a zero-tool connector", () => {
    // A hand-rolled frame with no reg() calls is not evidence of a real zero-tool connector —
    // it is this recognizer failing to find any, and `{ tools: [] }` is accepted by both
    // parseSpec and validateSpec, which would regenerate a connector that never existed.
    expect(run("const a = 1;").result).toBeUndefined();
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

  it("recognizes a negative numeric default (?? -1), via numericValue rather than a bare NumericLiteral read", () => {
    // Babel parses `-1` as a UnaryExpression wrapping a NumericLiteral, not a NumericLiteral
    // itself. ArgSchema constrains sign on neither `min`, `max` nor `default`, so `?? -1` is a
    // shape renderHoists can legitimately write — this is one of this retrofit's two sanctioned
    // widenings (args.ts's `.min(-5)`/`.max(-5)` is the other), and no corpus connector reaches
    // this recognizer with a negative literal today, so it does not move the reach histogram.
    const source = [
      "reg(",
      '  "t",',
      '  "d",',
      "  z.object({ offset: z.number().optional() }),",
      "  async (p) => {",
      "    const offset = p.offset ?? -1;",
      "    return jsonResult(await nrGet(`/x?o=${String(offset)}`));",
      "  },",
      ");",
    ].join("\n");
    const { result } = run(source);
    expect(result).toEqual({
      tools: [
        {
          name: "t",
          description: "d",
          args: { offset: { type: "number", optional: true, default: -1 } },
          path: "/x?o=${arg.offset|num}",
        },
      ],
    });
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

  it("does not recognize a reg(...) call reached through a member expression, e.g. obj.reg(...)", () => {
    // isRegCall requires an Identifier callee named "reg" — a member-expression callee is a
    // different shape (and not one renderTool ever emits), so the statement is simply not a reg
    // call at all: it is skipped rather than fed to recognizeOne. With zero reg() calls found,
    // this is now the same refusal as a module with none at all (see the zero-regs test above) —
    // `{ tools: [] }` would falsely derive a zero-tool connector — and the statement itself is
    // left unclaimed.
    const source = 'obj.reg("t", "d", z.object({}), async () => jsonResult(await nrGet("/x")));';
    const { result, unclaimed } = run(source);
    expect(result).toBeUndefined();
    expect(unclaimed).toHaveLength(1);
  });

  // Every source the recognizer must refuse outright, each with the reason it exists. One row
  // per case: the assertions are identical in all of them — no result derived, and nothing
  // claimed — so only the source and its rationale differ.
  const REFUSED_SOURCES = [
    [
      "refuses a ?? hoist whose right-hand side is not a string/number/boolean literal, rather than guessing a default",
      [
        "reg(",
        '  "t",',
        '  "d",',
        "  z.object({ scope: z.string().optional() }),",
        "  async (p) => {",
        "    const scope = p.scope ?? fallbackScope();",
        "    return jsonResult(await nrGet(`/x?s=${scope}`));",
        "  },",
        ");",
      ].join("\n"),
    ],

    // Three more non-literal RHS shapes for the same `?? <default>` guard, each pinned to its own
    // node type so a future change to hoistDefaultLiteral can't silently start accepting one.
    // A negative number (`?? -1`) is NOT among these — see the numericValue test above — because
    // `-1` unwraps to a real signed NumericLiteral, not one of these genuinely different shapes.
    [
      "refuses a ?? hoist whose right-hand side is null",
      [
        "reg(",
        '  "t",',
        '  "d",',
        "  z.object({ scope: z.string().optional() }),",
        "  async (p) => {",
        "    const scope = p.scope ?? null;",
        "    return jsonResult(await nrGet(`/x?s=${scope}`));",
        "  },",
        ");",
      ].join("\n"),
    ],
    [
      "refuses a ?? hoist whose right-hand side is an array literal",
      [
        "reg(",
        '  "t",',
        '  "d",',
        "  z.object({ scope: z.string().optional() }),",
        "  async (p) => {",
        "    const scope = p.scope ?? [1, 2, 3];",
        "    return jsonResult(await nrGet(`/x?s=${scope}`));",
        "  },",
        ");",
      ].join("\n"),
    ],
    [
      "refuses a ?? hoist whose right-hand side is an object literal",
      [
        "reg(",
        '  "t",',
        '  "d",',
        "  z.object({ scope: z.string().optional() }),",
        "  async (p) => {",
        "    const scope = p.scope ?? ({ a: 1 });",
        "    return jsonResult(await nrGet(`/x?s=${scope}`));",
        "  },",
        ");",
      ].join("\n"),
    ],

    [
      "refuses a hoist naming an arg the z.object({...}) schema does not declare",
      [
        "reg(",
        '  "t",',
        '  "d",',
        "  z.object({ other: z.string().optional() }),",
        "  async (p) => {",
        '    const scope = p.scope ?? "all";',
        "    return jsonResult(await nrGet(`/x?s=${scope}`));",
        "  },",
        ");",
      ].join("\n"),
    ],
    [
      "refuses a reg(...) call with a fifth argument, rather than reading only the first four",
      'reg("t", "d", z.object({}), async () => jsonResult(await nrGet("/x")), "extra");',
    ],
    [
      "refuses a reg(...) call missing its handler argument (three arguments), rather than reading a partial call",
      'reg("t", "d", z.object({}));',
    ],
    [
      "refuses a block handler with no statements at all, rather than treating it as an empty-but-valid body",
      ["reg(", '  "t",', '  "d",', "  z.object({}),", "  async (p) => {},", ");"].join("\n"),
    ],
    [
      "refuses a hoist position statement declaring more than one variable, e.g. const a = 1, b = 2;",
      [
        "reg(",
        '  "t",',
        '  "d",',
        "  z.object({ only_open: z.boolean().optional() }),",
        "  async (p) => {",
        "    const a = 1, b = 2;",
        "    return jsonResult(await nrGet(`/x`));",
        "  },",
        ");",
      ].join("\n"),
    ],
    [
      "refuses a hoist position statement whose declarator id is a destructuring pattern, not a plain identifier",
      [
        "reg(",
        '  "t",',
        '  "d",',
        "  z.object({ only_open: z.boolean().optional() }),",
        "  async (p) => {",
        "    const { only_open } = p;",
        "    return jsonResult(await nrGet(`/x`));",
        "  },",
        ");",
      ].join("\n"),
    ],
    [
      "refuses a handler whose jsonResult(...) call has more than one argument, rather than reading only the first",
      'reg("t", "d", z.object({}), async () => jsonResult(await nrGet("/x"), "extra"));',
    ],

    // Computed-member sweep: memberArgName reads `p.<name>` off a hoist's test/init — same hazard
    // as path-template.ts's argNameFromExpr (which cites args.ts:53 for it) and server/index.ts's
    // isConnect. A computed member (`p[only_open]`) has an Identifier `property` too — the KEY
    // variable's name, not a property name — and must not be read as naming the arg "only_open".
    [
      "refuses a computed p[only_open] hoist test instead of establishing p.only_open",
      [
        "reg(",
        '  "t",',
        '  "d",',
        "  z.object({ only_open: z.boolean().optional() }),",
        "  async (p) => {",
        '    const only = p[only_open] === true ? "true" : "false";',
        "    return jsonResult(await nrGet(`/x?o=${only}`));",
        "  },",
        ");",
      ].join("\n"),
    ],
  ];

  it.each(REFUSED_SOURCES)("%s", (_name, source) => {
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
