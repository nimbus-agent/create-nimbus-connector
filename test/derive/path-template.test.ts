import { beforeAll, describe, expect, it } from "bun:test";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { constDecl } from "../../src/derive/read.ts";
import { type PathLocal, recognizePath } from "../../src/derive/server/path-template.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";

beforeAll(async () => {
  await initParser();
});

function recognizedOf(expression: string, locals: Map<string, PathLocal> = new Map()) {
  const statement = parseModule(`const x = ${expression};`)[0]!;
  const init = constDecl(statement)!.init!;
  return recognizePath(init, locals);
}

/** Just the recovered path string — most of this file's assertions predate `staticStyle` and
 * stay concerned with placeholder recognition, not the static-path evidence tested separately
 * below. */
function pathOf(expression: string, locals: Map<string, PathLocal> = new Map()) {
  return recognizedOf(expression, locals)?.path;
}

/**
 * Finds the AstNode a `reg(...)` tool call's fetch helper receives as its path argument, by
 * scanning for the first call to `fetchLocal` or `fetchLocal + "Send"` inside the `nth` reg()
 * call in source order. Used to anchor a test to this repo's own real emitted output rather
 * than a hand-written approximation of it.
 */
function findPathArg(source: string, fetchLocal: string, toolIndex: number): unknown {
  const body = parseModule(source);
  const fetchNames = new Set([fetchLocal, `${fetchLocal}Send`]);
  const regCalls: unknown[] = [];

  function collectRegCalls(node: unknown): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) collectRegCalls(n);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record["type"] === "CallExpression") {
      const callee = record["callee"] as Record<string, unknown> | undefined;
      if (callee?.["type"] === "Identifier" && callee["name"] === "reg") regCalls.push(record);
    }
    for (const key in record) {
      if (key === "loc") continue;
      collectRegCalls(record[key]);
    }
  }
  collectRegCalls(body);

  const tool = regCalls[toolIndex] as Record<string, unknown> | undefined;
  if (tool === undefined) throw new Error(`no reg() call at index ${toolIndex}`);

  let pathArg: unknown;
  function findFetchArg(node: unknown): void {
    if (pathArg !== undefined) return;
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) findFetchArg(n);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record["type"] === "CallExpression" || record["type"] === "OptionalCallExpression") {
      const callee = record["callee"] as Record<string, unknown> | undefined;
      if (callee?.["type"] === "Identifier" && fetchNames.has(callee["name"] as string)) {
        pathArg = (record["arguments"] as unknown[])[0];
        return;
      }
    }
    for (const key in record) {
      if (key === "loc") continue;
      findFetchArg(record[key]);
    }
  }
  findFetchArg(tool);

  if (pathArg === undefined) throw new Error(`no fetch call found in reg() call ${toolIndex}`);
  return pathArg;
}

describe("recognizePath", () => {
  it("reads a static string path", () => {
    expect(pathOf('"/v2/applications.json"')).toBe("/v2/applications.json");
  });

  it("reads a template whose expression is a hoisted boolean local", () => {
    expect(
      pathOf(
        "`/v2/alerts.json?only_open=${only}`",
        new Map([["only", { arg: "only_open", bool: true }]]),
      ),
    ).toBe("/v2/alerts.json?only_open=${arg.only_open|bool}");
  });

  it("reads a template whose expression is an env accessor call", () => {
    expect(pathOf("`/api/${org()}/issues/`")).toBe("/api/${env.org}/issues/");
  });

  it("returns undefined for an expression it cannot name", () => {
    expect(pathOf("`/a/${p.q.toUpperCase()}`")).toBeUndefined();
  });

  it("reads a template whose expression is a hoisted local wrapped in String() (num mode)", () => {
    expect(
      pathOf(
        "`/api/v2/incidents?page[size]=${String(lim)}`",
        new Map([["lim", { arg: "limit", bool: false }]]),
      ),
    ).toBe("/api/v2/incidents?page[size]=${arg.limit|num}");
  });

  it("reads a template whose expression is a hoisted local wrapped in encodeURIComponent() (enc mode)", () => {
    expect(
      pathOf(
        "`/api/search?type=dash-db&query=${encodeURIComponent(q)}`",
        new Map([["q", { arg: "query", bool: false }]]),
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
        new Map([["lim", { arg: "limit", bool: false }]]),
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

  // Over-claiming defect: for a computed member `p[key]`, the `property` node is an Identifier
  // named "key" — the KEY VARIABLE's name, not a property name. Reading it unguarded named the
  // placeholder after whatever local happened to be the index (`${arg.key}`), an arg the
  // connector never declared. args.ts:53's recognizeArgs already guards the exact same hazard
  // on object keys; this is the read-side counterpart.
  it("returns undefined for a computed member expression, e.g. p[key]", () => {
    expect(pathOf("`/a/${p[key]}`")).toBeUndefined();
  });

  it("returns undefined for an expression that is neither an identifier, a member expression, nor a call", () => {
    expect(pathOf("`/a/${1}`")).toBeUndefined();
  });

  it("distinguishes a bool:false hoisted default from a bool:true hoisted boolean for the SAME bare identifier shape", () => {
    // Both hoist forms render as a bare `scope` identifier at the use site — the two are
    // indistinguishable without the `bool` flag PathLocal carries in from the hoist statement.
    expect(
      pathOf("`/v1/items?scope=${scope}`", new Map([["scope", { arg: "scope", bool: false }]])),
    ).toBe("/v1/items?scope=${arg.scope}");
    expect(
      pathOf("`/v1/items?scope=${scope}`", new Map([["scope", { arg: "scope", bool: true }]])),
    ).toBe("/v1/items?scope=${arg.scope|bool}");
  });

  it("recovers zzwrite_item_create's declared path from this repo's own real emitted output", async () => {
    await initFormatter();
    const spec = parseSpec(JSON.parse(await Bun.file("fixtures/zzwrite.spec.json").text()));
    const file = formatAll(generate(spec)).find((f) => f.path.join("/") === "src/server.ts")!;
    const tool = spec.tools.find((t) => t.name === "zzwrite_item_create")!;
    // Confirms the real emitted hoist is the default-value form (`p.scope ?? "all"`), not the
    // boolean ternary — this is the ground truth the PathLocal built below asserts against.
    expect(file.content).toContain('const scope = p.scope ?? "all";');

    const pathArg = findPathArg(file.content, spec.fetchHelper.local, 1);
    const recovered = recognizePath(
      pathArg as never,
      new Map([["scope", { arg: "scope", bool: false }]]),
    );
    expect(recovered?.path).toBe(tool.path);
    expect(recovered?.path).toBe("/v1/items?scope=${arg.scope}");
    // Dynamic (interpolates arg.scope), so it carries no staticPathStyle evidence — see
    // RecognizedPath's own docstring.
    expect(recovered?.staticStyle).toBeUndefined();
  });

  it("rejects (rather than mis-recovers) a query-branch new URL(...) template, whose leading expression is a base-URL prefix fused in by baseExpr", async () => {
    // discord_channel_messages emits `new URL(\`${DISCORD_API}/channels/${encodeURIComponent(
    // parsed.channelId)}/messages\`)` — DISCORD_API is a bare Identifier that is neither an
    // env accessor call nor a known local, so placeholderFor correctly refuses to guess at it,
    // and the whole template comes back undefined rather than a wrong (prefixed) string. This
    // node shape is out of this recognizer's stated scope (see the module docstring); this
    // test pins that the refusal is real and clean, not a crash or a silent wrong answer.
    await initFormatter();
    const spec = parseSpec(JSON.parse(await Bun.file("fixtures/discord.spec.json").text()));
    const file = formatAll(generate(spec)).find((f) => f.path.join("/") === "src/server.ts")!;
    expect(file.content).toContain(
      "const u = new URL(`${DISCORD_API}/channels/${encodeURIComponent(parsed.channelId)}/messages`);",
    );

    const body = parseModule(file.content);
    let urlArg: unknown;
    function findUrlArg(node: unknown): void {
      if (urlArg !== undefined) return;
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const n of node) findUrlArg(n);
        return;
      }
      const record = node as Record<string, unknown>;
      if (record["type"] === "NewExpression") {
        const callee = record["callee"] as Record<string, unknown> | undefined;
        if (callee?.["type"] === "Identifier" && callee["name"] === "URL") {
          urlArg = (record["arguments"] as unknown[])[0];
          return;
        }
      }
      for (const key in record) {
        if (key === "loc") continue;
        findUrlArg(record[key]);
      }
    }
    findUrlArg(body);

    expect(recognizePath(urlArg as never, new Map())).toBeUndefined();
  });
});

describe("recognizePath: staticStyle", () => {
  // The staticPathStyle evidence index.ts's voteStaticPathStyle consumes — see RecognizedPath's
  // own docstring for why only these two shapes are decisive.
  it('reports "quoted" for a plain string literal', () => {
    expect(recognizedOf('"/v2/applications.json"')?.staticStyle).toBe("quoted");
  });

  it('reports "template" for a backtick literal with no interpolation', () => {
    expect(recognizedOf("`/v2/applications.json`")?.staticStyle).toBe("template");
  });

  it("reports no staticStyle for a dynamic template — the emitter's own choice is invisible on it", () => {
    expect(recognizedOf("`/api/${org()}/issues/`")?.staticStyle).toBeUndefined();
  });
});
