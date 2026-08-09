import { beforeAll, describe, expect, it } from "bun:test";
import { type AstNode, initParser, parseModule } from "../../src/derive/ast.ts";
import { createClaimSet } from "../../src/derive/claims.ts";
import { functionBody } from "../../src/derive/read.ts";
import { recognizeConditionalPath } from "../../src/derive/server/conditional-path.ts";
import { pathFromJsonResult, recognizeTools } from "../../src/derive/server/tools-hand.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

beforeAll(async () => {
  await initFormatter();
  await initParser();
});

/**
 * The handler's own statements.
 *
 * The ladder is a run of statements INSIDE a handler block, and a bare `return` at module scope is
 * a Babel syntax error under `sourceType: "module"` — so each case is wrapped in a function and
 * unwrapped again rather than parsed as a module body. `functionBody` is read.ts's guarded
 * accessor; nothing here reaches a node field directly.
 */
function handlerStatements(param: string, lines: readonly string[]): AstNode[] {
  const statements = parseModule(`async function h(${param}) {\n${lines.join("\n")}\n}\n`);
  const body = functionBody(statements[0]);
  if (body === undefined) throw new Error("the test handler did not parse as a function");
  return body;
}

/**
 * The REAL return-shape reader, partially applied — `recognizeConditionalPath`'s whole contract is
 * that it reads the LADDER and delegates each rung's `return jsonResult(await …)` to the one
 * reader `tools-hand.ts` already owns. A stand-in here would be a second definition of that shape,
 * free to accept what the real one rejects.
 */
const readReturn = (node: AstNode | undefined) => pathFromJsonResult(node, new Map(), "acmeGet");

function recognize(param: string, lines: readonly string[]) {
  return recognizeConditionalPath(handlerStatements(param, lines), param, readReturn);
}

describe("recognizeConditionalPath", () => {
  it("reads a two-rung ladder back into pathWhen plus a fallthrough path", () => {
    const got = recognize("p", [
      "if (p.buildId === undefined) {",
      "  return jsonResult(await acmeGet(`/apps/${encodeURIComponent(p.appId)}`));",
      "}",
      "return jsonResult(await acmeGet(`/builds/${encodeURIComponent(p.buildId)}`));",
    ]);
    expect(got?.pathWhen).toEqual([{ absent: "buildId", path: "/apps/${arg.appId|enc}" }]);
    expect(got?.path).toBe("/builds/${arg.buildId|enc}");
  });

  it("keeps several guards in source order, since the ladder's order is the author's", () => {
    // Order is behaviour, not presentation: the first guard whose argument is absent wins, so a
    // reader that sorted or reversed them would derive a spec the emitter re-renders into a
    // different set of endpoints.
    const got = recognize("p", [
      "if (p.buildId === undefined) {",
      "  return jsonResult(await acmeGet(`/apps/${encodeURIComponent(p.appId)}`));",
      "}",
      "if (p.appId === undefined) {",
      '  return jsonResult(await acmeGet("/apps"));',
      "}",
      "return jsonResult(await acmeGet(`/builds/${encodeURIComponent(p.buildId)}`));",
    ]);
    expect(got?.pathWhen).toEqual([
      { absent: "buildId", path: "/apps/${arg.appId|enc}" },
      { absent: "appId", path: "/apps" },
    ]);
  });

  it("refuses an else branch rather than reading it as a rung", () => {
    const got = recognize("p", [
      "if (p.buildId === undefined) { return jsonResult(await acmeGet(`/apps`)); }",
      "else { return jsonResult(await acmeGet(`/builds`)); }",
    ]);
    expect(got).toBeUndefined();
  });

  it("refuses a compound guard, which means something a ladder cannot say", () => {
    // semgrep's shape: one path when ALL are absent, not three paths. Reading it as a ladder
    // would change behaviour.
    const got = recognize("p", [
      "if (p.a === undefined && p.b === undefined) { return jsonResult(await acmeGet(`/x`)); }",
      "return jsonResult(await acmeGet(`/y`));",
    ]);
    expect(got).toBeUndefined();
  });

  it("recognises a handler whose parameter is not named p", () => {
    // 92 corpus handlers use `parsed`. A recogniser hardcoding `p.` fails all of them SILENTLY —
    // it matches nothing, the connector stays blocked, and that is indistinguishable from one that
    // genuinely cannot be read. Every other test in this file would still pass.
    const got = recognize("parsed", [
      "if (parsed.buildId === undefined) {",
      "  return jsonResult(await acmeGet(`/apps`));",
      "}",
      "return jsonResult(await acmeGet(`/builds/${encodeURIComponent(parsed.buildId)}`));",
    ]);
    expect(got?.pathWhen).toEqual([{ absent: "buildId", path: "/apps" }]);
  });

  it("refuses a guard whose receiver is not the parameter it was given", () => {
    // The other half of the test above, and the half that makes it an assertion about the PARAM
    // rather than about `parsed` happening to work: the same source, read with the wrong name,
    // must refuse. Without this, a reader ignoring `param` entirely passes both.
    const lines = [
      "if (parsed.buildId === undefined) {",
      "  return jsonResult(await acmeGet(`/apps`));",
      "}",
      "return jsonResult(await acmeGet(`/builds/${encodeURIComponent(parsed.buildId)}`));",
    ];
    expect(recognizeConditionalPath(handlerStatements("parsed", lines), "p", readReturn)).toBe(
      undefined,
    );
  });

  it("refuses a guard testing anything other than === undefined", () => {
    const got = recognize("p", [
      'if (p.buildId === "") { return jsonResult(await acmeGet(`/x`)); }',
      "return jsonResult(await acmeGet(`/y`));",
    ]);
    expect(got).toBeUndefined();
  });

  it("refuses a guard testing !== undefined", () => {
    // `!==` recovers the same argument name and the same two paths — with the two endpoints
    // swapped. The operator is the whole meaning here, so a reader checking only the node type
    // would derive a connector that calls the wrong endpoint on every request.
    const got = recognize("p", [
      "if (p.buildId !== undefined) { return jsonResult(await acmeGet(`/x`)); }",
      "return jsonResult(await acmeGet(`/y`));",
    ]);
    expect(got).toBeUndefined();
  });

  it("refuses a rung whose consequent is not a lone return", () => {
    const got = recognize("p", [
      "if (p.buildId === undefined) {",
      "  console.log(p.appId);",
      "  return jsonResult(await acmeGet(`/apps`));",
      "}",
      "return jsonResult(await acmeGet(`/builds`));",
    ]);
    expect(got).toBeUndefined();
  });

  it("refuses a ladder with no unguarded fallthrough", () => {
    // Without the final return there is no `path` for the tool at all, and the emitter always
    // writes one — the guards are rendered BEFORE it, never instead of it.
    const got = recognize("p", [
      "if (p.buildId === undefined) { return jsonResult(await acmeGet(`/apps`)); }",
    ]);
    expect(got).toBeUndefined();
  });

  it("refuses a statement between the last guard and the fallthrough", () => {
    const got = recognize("p", [
      "if (p.buildId === undefined) { return jsonResult(await acmeGet(`/apps`)); }",
      "const extra = 1;",
      "return jsonResult(await acmeGet(`/builds`));",
    ]);
    expect(got).toBeUndefined();
  });

  it("declines a plain single-return handler, leaving it to the ordinary reader", () => {
    // Not a refusal of a broken ladder — a handler with no guard at all is the single-path shape
    // `recognizeHoistedBlock` reads, and returning undefined here is what hands it on.
    const got = recognize("p", ["return jsonResult(await acmeGet(`/builds`));"]);
    expect(got).toBeUndefined();
  });

  it("refuses a ladder over the write helper, whose per-rung bodies it cannot pin equal", () => {
    // The emitter CAN write this (pathWhen is legal on a POST) and this reader deliberately
    // refuses it rather than reading the fallthrough's body and ignoring the rungs' — see
    // `plainReadPath`. A refusal is a named blocker; a wrong claim is a connector that re-emits
    // with the wrong body in every guard.
    const got = recognize("p", [
      "if (p.buildId === undefined) {",
      '  return jsonResult(await acmeGetSend(`/apps`, "POST", JSON.stringify({ appId: p.appId })));',
      "}",
      'return jsonResult(await acmeGetSend(`/builds`, "POST", JSON.stringify({ appId: p.appId })));',
    ]);
    expect(got).toBeUndefined();
  });

  it("refuses two paths in one ladder that disagree about the static-path convention", () => {
    // Both are fully static, so both are staticPathStyle evidence — and `renderPath` renders every
    // path in one tool through the SAME RenderContext, so a quoted fallthrough beside a
    // backticked guard is a module this emitter cannot have written.
    const got = recognize("p", [
      "if (p.buildId === undefined) { return jsonResult(await acmeGet(`/apps`)); }",
      'return jsonResult(await acmeGet("/builds"));',
    ]);
    expect(got).toBeUndefined();
  });

  it("carries the guard's own static-path evidence when the fallthrough has none", () => {
    // A dynamic fallthrough votes nothing (see `RecognizedPath.staticStyle`), so without reading
    // the guards this tool would abstain — and a connector whose only static path lives in a guard
    // would re-emit that guard under the wrong convention.
    const got = recognize("p", [
      'if (p.buildId === undefined) { return jsonResult(await acmeGet("/apps")); }',
      "return jsonResult(await acmeGet(`/builds/${encodeURIComponent(p.buildId)}`));",
    ]);
    expect(got?.staticStyle).toBe("quoted");
  });
});

/**
 * The reader's other half: that `recognizeTools` actually reaches it, on bytes this repository
 * emitted rather than on hand-written source. A recognizer nothing calls moves no connector.
 */
describe("recognizeTools reads a conditional-endpoint tool", () => {
  const SPEC = {
    name: "zz",
    displayName: "ZZ",
    description: "d",
    serviceLabel: "ZZ",
    style: "hand-rolled",
    env: [{ vars: ["ZZ_TOKEN"], local: "authHeaders", bindings: ["token"], auth: "bearer" }],
    fetchHelper: { local: "zzGet", base: "https://api.zz.test", headers: "authHeaders" },
    tools: [
      {
        name: "zz_get",
        description: "Fetch a build, or the app when no build is named.",
        path: "/builds/${arg.buildId|enc}",
        pathWhen: [{ absent: "buildId", path: "/apps/${arg.appId|enc}" }],
        args: {
          appId: { type: "string", min: 1 },
          buildId: { type: "string", min: 1, optional: true },
        },
      },
    ],
  };

  function emittedServer(spec: unknown): string {
    const files = formatAll(generate(parseSpec(spec)));
    const f = files.find((x) => displayPath(x.path) === "src/server.ts");
    if (f === undefined) throw new Error("no src/server.ts emitted");
    return f.content;
  }

  it("recovers pathWhen and the fallthrough path from emitted bytes", () => {
    const statements = parseModule(emittedServer(SPEC));
    const claims = createClaimSet();
    const result = recognizeTools(statements, claims, "zzGet");
    expect(result?.tools).toHaveLength(1);
    expect(result?.tools[0]).toMatchObject({
      name: "zz_get",
      path: "/builds/${arg.buildId|enc}",
      pathWhen: [{ absent: "buildId", path: "/apps/${arg.appId|enc}" }],
    });
  });

  it("abstains from the handlerStyle vote, since a guarded tool is always a block", () => {
    // `renderTool` returns the block form for a guarded tool whatever `spec.handlerStyle` says, so
    // a guarded block with no hoists is NOT evidence of handlerStyle: "block". Voting would put a
    // field in the derived spec its author never wrote — and would make `recognizeTools` refuse a
    // connector pairing this tool with a concise one outright.
    const statements = parseModule(emittedServer(SPEC));
    const result = recognizeTools(statements, createClaimSet(), "zzGet");
    expect(result?.handlerStyle).toBeUndefined();
  });
});
