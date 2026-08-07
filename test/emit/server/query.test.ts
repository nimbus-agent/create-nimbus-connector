import { describe, expect, it } from "bun:test";
import { renderPath } from "../../../src/emit/server/path-template.ts";
import { queryArgsUsed, renderQueryLines } from "../../../src/emit/server/query.ts";
import { type ArgSpec, parsePathTemplate } from "../../../src/spec.ts";

const NO_HOISTS = new Map<string, string>();

const STRING_ARG: ArgSpec = { type: "string", optional: false, int: false };
const NUMBER_ARG: ArgSpec = { type: "number", optional: false, int: false };

describe("renderQueryLines", () => {
  it("sets an unconditional numeric parameter through String()", () => {
    expect(
      renderQueryLines([{ name: "limit", arg: "limit" }], {
        param: "parsed",
        hoisted: NO_HOISTS,
        args: { limit: NUMBER_ARG },
      }),
    ).toEqual(['u.searchParams.set("limit", String(parsed.limit));']);
  });

  it("sets an unconditional string parameter bare", () => {
    expect(
      renderQueryLines([{ name: "filter", arg: "filter" }], {
        param: "parsed",
        hoisted: NO_HOISTS,
        args: { filter: STRING_ARG },
      }),
    ).toEqual(['u.searchParams.set("filter", parsed.filter);']);
  });

  it("guards a string parameter on undefined and empty, bare — omitWhen: empty", () => {
    expect(
      renderQueryLines([{ name: "after", arg: "after", omitWhen: "empty" }], {
        param: "parsed",
        hoisted: NO_HOISTS,
        args: { after: STRING_ARG },
      }),
    ).toEqual([
      'if (parsed.after !== undefined && parsed.after !== "") {',
      '  u.searchParams.set("after", parsed.after);',
      "}",
    ]);
  });

  it("guards a string parameter on undefined only, bare — omitWhen: absent", () => {
    expect(
      renderQueryLines([{ name: "pageToken", arg: "pageToken", omitWhen: "absent" }], {
        param: "parsed",
        hoisted: NO_HOISTS,
        args: { pageToken: STRING_ARG },
      }),
    ).toEqual([
      "if (parsed.pageToken !== undefined) {",
      '  u.searchParams.set("pageToken", parsed.pageToken);',
      "}",
    ]);
  });

  it("wraps a guarded numeric parameter in String() with no empty check — github's page", () => {
    const lines = renderQueryLines([{ name: "page", arg: "page", omitWhen: "absent" }], {
      param: "parsed",
      hoisted: NO_HOISTS,
      args: { page: NUMBER_ARG },
    });
    expect(lines).toEqual([
      "if (parsed.page !== undefined) {",
      '  u.searchParams.set("page", String(parsed.page));',
      "}",
    ]);
    expect(lines.join("\n")).not.toContain('!== ""');
  });

  it("references the hoisted const when the arg declares a default", () => {
    const hoisted = new Map([["limit", "lim"]]);
    expect(
      renderQueryLines([{ name: "limit", arg: "limit" }], {
        param: "parsed",
        hoisted,
        args: { limit: NUMBER_ARG },
      }),
    ).toEqual(['u.searchParams.set("limit", String(lim));']);
  });

  it("quotes a key that is not a JS identifier", () => {
    expect(
      renderQueryLines([{ name: "page[size]", arg: "limit" }], {
        param: "parsed",
        hoisted: NO_HOISTS,
        args: { limit: NUMBER_ARG },
      }),
    ).toEqual(['u.searchParams.set("page[size]", String(parsed.limit));']);
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
