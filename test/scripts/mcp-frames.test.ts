/**
 * Unit tests for the MCP frames the two executing harnesses send and read.
 *
 * These decide what an acceptance run BELIEVES happened. `toResult` turns a JSON-RPC reply
 * into the {isError, text} pair every runtime check asserts on, and `describeToolsList`
 * turns a tools/list reply into a PASS or a FAIL — so a wrong answer here does not surface
 * as a broken harness, it surfaces as a green run that verified something else. Both used to
 * sit inside files that spawn `bun install`, which is why neither had ever been executed by
 * a test.
 */

import { describe, expect, it } from "bun:test";
import {
  describeToolsList,
  type RpcMessage,
  toolCallRequest,
  toResult,
} from "../../scripts/_lib/mcp-frames.ts";

describe("toolCallRequest", () => {
  it("builds a well-formed tools/call frame carrying the id, name and arguments", () => {
    expect(toolCallRequest(100, { name: "rt_get", args: { id: "a b/c" } })).toEqual({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: { name: "rt_get", arguments: { id: "a b/c" } },
    });
  });

  it("nests the arguments under params.arguments, not params", () => {
    // The MCP wire shape. Flattening the args into params is the mistake that produces a
    // server which answers every call with an empty argument set — every "unset optional
    // boolean" style assertion would then pass for the wrong reason.
    const frame = toolCallRequest(101, { name: "rt_create", args: { title: "hello" } }) as {
      params: Record<string, unknown>;
    };

    expect(frame.params.arguments).toEqual({ title: "hello" });
    expect(frame.params.title).toBeUndefined();
  });

  it("keeps an empty argument set as an empty object rather than dropping it", () => {
    const frame = toolCallRequest(100, { name: "rt_list", args: {} }) as {
      params: { arguments: unknown };
    };

    expect(frame.params.arguments).toEqual({});
  });
});

describe("toResult", () => {
  it("reads a successful reply's text content", () => {
    const msg: RpcMessage = { id: 100, result: { content: [{ text: '{"ok":true}' }] } };

    expect(toResult(msg)).toEqual({ isError: false, text: '{"ok":true}' });
  });

  it("concatenates a multi-part content array in order", () => {
    const msg: RpcMessage = { result: { content: [{ text: "part-1 " }, { text: "part-2" }] } };

    expect(toResult(msg).text).toBe("part-1 part-2");
  });

  it("treats a result flagged isError as an error", () => {
    // The shape the MCP SDK uses for a tool that threw: a SUCCESSFUL JSON-RPC response whose
    // result says the tool failed. Reading only the protocol-level `error` field would make
    // "a non-2xx response surfaces as a tool error naming the status" pass vacuously — the
    // 500 check is precisely this shape.
    const msg: RpcMessage = {
      result: { isError: true, content: [{ text: "HTTP 500 from /boom" }] },
    };

    expect(toResult(msg)).toEqual({ isError: true, text: "HTTP 500 from /boom" });
  });

  it("treats a protocol-level error frame as an error and surfaces its message", () => {
    const msg: RpcMessage = { id: 100, error: { message: "Tool rt_nope not found" } };

    expect(toResult(msg)).toEqual({ isError: true, text: "Tool rt_nope not found" });
  });

  it("does not mistake isError: false for a failure", () => {
    expect(toResult({ result: { isError: false, content: [{ text: "fine" }] } })).toEqual({
      isError: false,
      text: "fine",
    });
  });

  it("yields empty text rather than throwing on a reply with no content at all", () => {
    // A frame the harness did not expect must not crash the run mid-scenario: the check it
    // feeds reports a failure with "(no result)", which is diagnosable. An exception here
    // aborts the remaining scenarios and loses their verdicts.
    expect(toResult({ id: 100 })).toEqual({ isError: false, text: "" });
    expect(toResult({ id: 100, result: {} })).toEqual({ isError: false, text: "" });
  });

  it("tolerates a content part with no text field", () => {
    const msg: RpcMessage = { result: { content: [{ text: "a" }, {}, { text: "b" }] } };

    expect(toResult(msg).text).toBe("ab");
  });
});

describe("describeToolsList", () => {
  it("passes when every expected tool is present", () => {
    expect(describeToolsList([{ name: "rt_list" }, { name: "rt_get" }], ["rt_list"])).toEqual({
      ok: true,
      output: "tools/list returned rt_list, rt_get",
    });
  });

  it("fails and names the tools that are missing", () => {
    const result = describeToolsList([{ name: "rt_list" }], ["rt_list", "rt_get", "rt_boom"]);

    expect(result.ok).toBe(false);
    expect(result.output).toBe("tools/list missing rt_get, rt_boom; got rt_list");
  });

  it("fails when the server described no tools at all", () => {
    // The shape a server that started but registered nothing produces. Reporting "(none)"
    // rather than an empty tail is what distinguishes it from a formatting slip.
    const result = describeToolsList([], ["rt_list"]);

    expect(result.ok).toBe(false);
    expect(result.output).toBe("tools/list missing rt_list; got (none)");
  });

  it("fails when the reply carried no tools field, rather than treating it as a pass", () => {
    // `msg.result?.tools` is undefined for a malformed or truncated reply. Defaulting to an
    // empty list and then reporting ok:true — which `expected.filter(...)` over `undefined`
    // would do if the guard were dropped — is a silent green on a server that never answered.
    const result = describeToolsList(undefined, ["rt_list"]);

    expect(result.ok).toBe(false);
    expect(result.output).toBe("tools/list missing rt_list; got (none)");
  });

  it("does not fail a server that offers MORE tools than expected", () => {
    // The expectation is a subset check on purpose: adding a tool to a fixture must not
    // require touching this harness.
    expect(describeToolsList([{ name: "a" }, { name: "b" }], ["a"]).ok).toBe(true);
  });

  it("passes vacuously only when nothing was expected", () => {
    expect(describeToolsList([], [])).toEqual({ ok: true, output: "tools/list returned " });
  });
});
