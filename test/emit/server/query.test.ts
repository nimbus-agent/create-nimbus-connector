import { describe, expect, it } from "bun:test";
import { parsePathTemplate, renderPath } from "../../../src/emit/server/path-template.ts";
import { queryArgsUsed, renderQueryLines } from "../../../src/emit/server/query.ts";

const NO_HOISTS = new Map<string, string>();

describe("renderQueryLines", () => {
  it("sets an unconditional parameter through String()", () => {
    expect(
      renderQueryLines([{ name: "limit", arg: "limit" }], { param: "parsed", hoisted: NO_HOISTS }),
    ).toEqual(['u.searchParams.set("limit", String(parsed.limit));']);
  });

  it("guards a conditional parameter on undefined and empty", () => {
    expect(
      renderQueryLines([{ name: "after", arg: "after", omitWhen: "empty" }], {
        param: "parsed",
        hoisted: NO_HOISTS,
      }),
    ).toEqual([
      'if (parsed.after !== undefined && parsed.after !== "") {',
      '  u.searchParams.set("after", parsed.after);',
      "}",
    ]);
  });

  it("references the hoisted const when the arg declares a default", () => {
    const hoisted = new Map([["limit", "lim"]]);
    expect(
      renderQueryLines([{ name: "limit", arg: "limit" }], { param: "parsed", hoisted }),
    ).toEqual(['u.searchParams.set("limit", String(lim));']);
  });

  it("quotes a key that is not a JS identifier", () => {
    expect(
      renderQueryLines([{ name: "page[size]", arg: "limit" }], {
        param: "parsed",
        hoisted: NO_HOISTS,
      }),
    ).toEqual(['u.searchParams.set("page[size]", String(parsed.limit));']);
  });

  it("does not wrap a guarded value in String(), matching the corpus", () => {
    const lines = renderQueryLines([{ name: "after", arg: "after", omitWhen: "empty" }], {
      param: "parsed",
      hoisted: NO_HOISTS,
    });
    expect(lines.join("\n")).not.toContain("String(");
  });
});

describe("queryArgsUsed", () => {
  it("reports only hoisted args the query names", () => {
    const hoisted = new Map([
      ["limit", "lim"],
      ["other", "oth"],
    ]);
    expect(queryArgsUsed([{ name: "limit", arg: "limit" }], hoisted)).toEqual(new Set(["limit"]));
  });
});

describe("renderPath prefix", () => {
  it("prefixes a dynamic path and stays a template literal", () => {
    const segments = parsePathTemplate("/channels/${arg.channelId|enc}/messages");
    expect(
      renderPath(segments, { param: "parsed", hoisted: NO_HOISTS, prefix: "${DISCORD_API}" }),
    ).toBe("`${DISCORD_API}/channels/${encodeURIComponent(parsed.channelId)}/messages`");
  });

  it("promotes a static path to a template literal when prefixed", () => {
    const segments = parsePathTemplate("/conferenceRecords");
    expect(
      renderPath(segments, { param: "parsed", hoisted: NO_HOISTS, prefix: "${MEET_BASE}" }),
    ).toBe("`${MEET_BASE}/conferenceRecords`");
  });
});
