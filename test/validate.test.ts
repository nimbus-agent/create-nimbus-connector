import { describe, expect, it } from "bun:test";
import { parseSpec } from "../src/spec.ts";
import { validateSpec } from "../src/validate.ts";

function specWith(over: Record<string, unknown>) {
  return parseSpec({
    name: "sentry",
    displayName: "Sentry",
    description: "Sentry connector.",
    serviceLabel: "Sentry",
    style: "hand-rolled",
    env: [{ vars: ["SENTRY_ORG_SLUG"], local: "org", bindings: ["o"], required: true }],
    fetchHelper: { local: "sentryGet", base: "${env.org}", headers: "headers" },
    tools: [],
    ...over,
  });
}

function restKitSpecWith(over: Record<string, unknown>) {
  return parseSpec({
    name: "discord",
    title: "Discord",
    displayName: "Discord",
    description: "Discord connector.",
    serviceLabel: "Discord",
    style: "rest-kit",
    env: [
      // Not "token": that is now a reserved emitter identifier — the client-credentials
      // branch emits `token()` at module scope.
      {
        vars: ["DISCORD_TOKEN"],
        local: "tokenHeaders",
        bindings: ["t"],
        required: true,
        auth: "bearer",
      },
    ],
    fetchHelper: { local: "discordGet", base: "https://discord.com/api/v10" },
    tools: [],
    ...over,
  });
}

describe("validateSpec", () => {
  it("accepts a spec with no collisions", () => {
    expect(() => validateSpec(specWith({}))).not.toThrow();
  });

  it("rejects a hoisted arg local that shadows an env accessor", () => {
    const s = specWith({
      tools: [
        {
          name: "sentry_issue_list",
          description: "List issues.",
          args: { limit: { type: "number", optional: true, default: 20, local: "org" } },
          path: "/projects/${env.org}/issues/",
        },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/org/);
  });

  it("rejects two env accessors with the same local", () => {
    const s = specWith({
      env: [
        { vars: ["A"], local: "dup", bindings: ["a"], required: true },
        { vars: ["B"], local: "dup", bindings: ["b"], required: true },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/dup/);
  });

  it("rejects an env local colliding with a reserved emitter name", () => {
    const s = specWith({ env: [{ vars: ["A"], local: "reg", bindings: ["a"], required: true }] });
    expect(() => validateSpec(s)).toThrow(/reg/);
  });

  it("rejects a fetchHelper local colliding with an env local", () => {
    const s = specWith({ fetchHelper: { local: "org", base: "https://x", headers: "headers" } });
    expect(() => validateSpec(s)).toThrow(/org/);
  });

  it("rejects duplicate tool names", () => {
    const t = { name: "dup_tool", description: "d.", path: "/a" };
    expect(() => validateSpec(specWith({ tools: [t, t] }))).toThrow(/dup_tool/);
  });

  it("rejects a rest-kit spec whose env local collides with the registrar name", () => {
    const s = restKitSpecWith({
      title: "Foo",
      env: [{ vars: ["A"], local: "registerFooTool", bindings: ["a"], auth: "bearer" }],
    });
    expect(() => validateSpec(s)).toThrow(/registerFooTool/);
  });

  it("accepts a hand-rolled spec whose env local matches what rest-kit would claim", () => {
    const s = specWith({
      title: "Foo",
      style: "hand-rolled",
      env: [{ vars: ["A"], local: "registerFooTool", bindings: ["a"], required: true }],
    });
    expect(() => validateSpec(s)).not.toThrow();
  });

  // F2: tool path placeholders must resolve against the spec that declared them.
  it("rejects a rest-kit tool path referencing ${env.X} — rest-kit emits no env accessors", () => {
    const s = restKitSpecWith({
      tools: [
        {
          name: "discord_guild_list",
          description: "d.",
          path: "/guilds/${env.anything}",
        },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/env accessors/);
  });

  it("rejects a hand-rolled tool path referencing an env local the spec never declares", () => {
    const s = specWith({
      tools: [
        {
          name: "sentry_issue_list",
          description: "d.",
          path: "/projects/${env.nosuch}/issues/",
        },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/nosuch/);
  });

  it("rejects a tool path referencing an arg the tool never declares", () => {
    const s = specWith({
      tools: [
        {
          name: "sentry_issue_list",
          description: "d.",
          path: "/projects/${env.org}/${arg.typo}/issues/",
        },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/typo/);
  });

  it("accepts a hand-rolled tool path whose env and arg references both resolve", () => {
    const s = specWith({
      tools: [
        {
          name: "sentry_issue_list",
          description: "d.",
          args: { projectSlug: { type: "string" } },
          path: "/projects/${env.org}/${arg.projectSlug}/issues/",
        },
      ],
    });
    expect(() => validateSpec(s)).not.toThrow();
  });

  it("accepts a rest-kit tool path whose arg references resolve and has no env reference", () => {
    const s = restKitSpecWith({
      tools: [
        {
          name: "discord_channel_list",
          description: "d.",
          args: { guildId: { type: "string" } },
          path: "/guilds/${arg.guildId|enc}/channels",
        },
      ],
    });
    expect(() => validateSpec(s)).not.toThrow();
  });

  // F7: |bool is restricted to boolean-typed args.
  it("rejects a |bool placeholder applied to a non-boolean arg", () => {
    const s = specWith({
      tools: [
        {
          name: "sentry_issue_list",
          description: "d.",
          args: { projectSlug: { type: "string" } },
          path: "/projects/${env.org}/issues/?flag=${arg.projectSlug|bool}",
        },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/"projectSlug".*boolean/s);
  });

  it("accepts a |bool placeholder applied to a boolean arg", () => {
    const s = specWith({
      tools: [
        {
          name: "sentry_issue_list",
          description: "d.",
          args: { onlyOpen: { type: "boolean", optional: true } },
          path: "/projects/${env.org}/issues/?open=${arg.onlyOpen|bool}",
        },
      ],
    });
    expect(() => validateSpec(s)).not.toThrow();
  });

  it("rejects an env local colliding with the reserved global `fetch` (F6)", () => {
    const s = specWith({ env: [{ vars: ["A"], local: "fetch", bindings: ["a"], required: true }] });
    expect(() => validateSpec(s)).toThrow(/fetch/);
  });

  /**
   * Final fix wave, MINOR 1. Stage C introduced three module-scope names — `token`,
   * `cachedToken` and `<fetchHelper.local>Send` — and registered none of them, so a spec
   * could name an env accessor after one and emit two declarations of it.
   */
  describe("Stage C's emitted module-scope names are reserved", () => {
    for (const name of ["token", "cachedToken", "encodeBasicAuthHeader", "URLSearchParams"]) {
      it(`rejects an env local named "${name}"`, () => {
        const s = specWith({
          env: [{ vars: ["A"], local: name, bindings: ["a"], required: true }],
        });
        expect(() => validateSpec(s)).toThrow(new RegExp(`"${name}"`));
      });
    }

    it("rejects an env local colliding with the write helper's derived name", () => {
      // The write helper is `<fetchHelper.local>Send`, so "sentryGetSend" is taken by
      // fetchHelper.local "sentryGet" even though no spec field spells it out.
      const s = specWith({
        env: [{ vars: ["A"], local: "sentryGetSend", bindings: ["a"], required: true }],
      });
      expect(() => validateSpec(s)).toThrow(/sentryGetSend/);
    });

    it("rejects a hoisted arg local colliding with the write helper's derived name", () => {
      const s = specWith({
        tools: [
          {
            name: "sentry_issue_list",
            description: "d.",
            args: {
              limit: { type: "number", optional: true, default: 20, local: "sentryGetSend" },
            },
            path: "/issues/?limit=${arg.limit|num}",
          },
        ],
      });
      expect(() => validateSpec(s)).toThrow(/sentryGetSend/);
    });
  });

  it("correctly strips non-alphanumerics from title in registrar name", () => {
    const s = restKitSpecWith({
      title: "Google Meet",
      env: [{ vars: ["A"], local: "registerGoogleMeetTool", bindings: ["a"], auth: "bearer" }],
    });
    expect(() => validateSpec(s)).toThrow(/registerGoogleMeetTool/);
  });
});

describe("validateSpec, identifiers the new Stage D conventions introduce", () => {
  it("rejects a base const that collides with an env accessor", () => {
    expect(() =>
      validateSpec(
        specWith({
          fetchHelper: {
            local: "sentryGet",
            base: "https://sentry.io",
            baseConst: "org",
            headers: "org",
          },
        }),
      ),
    ).toThrow(/Identifier collision: "org"/);
  });

  it("rejects a raw-token accessor that collides with the fetch helper", () => {
    expect(() =>
      validateSpec(
        specWith({
          env: [
            {
              vars: ["SENTRY_AUTH_TOKEN"],
              local: "authHeader",
              tokenLocal: "sentryGet",
              bindings: ["t"],
              auth: "bearer",
            },
          ],
          fetchHelper: { local: "sentryGet", base: "https://sentry.io", headers: "authHeader" },
        }),
      ),
    ).toThrow(/Identifier collision: "sentryGet"/);
  });

  // Stage D added module-scope declarations that nothing claimed. Each of these is a name the
  // emitter itself declares or binds in src/server.ts, so a spec reusing one emits two
  // declarations of it and the collision surfaces only at the generated package's own tsc —
  // which is precisely what this list exists to pull forward to parse time.
  describe("Stage D reserved identifiers", () => {
    for (const name of [
      "runReadOnlyMcpConnector",
      "ZodToolRegistrar",
      "searchToolInputSchema",
      "matchesResult",
      "McpListResult",
      "ZodObjectSchema",
      "SearchMatchOptions",
      "root",
    ]) {
      it(`rejects an env local named ${name}`, () => {
        expect(() =>
          validateSpec(
            specWith({
              env: [{ vars: ["SENTRY_TOKEN"], local: name, bindings: ["t"], auth: "bearer" }],
            }),
          ),
        ).toThrow(new RegExp(`Identifier collision: "${name}"`));
      });
    }
  });

  it("accepts the mercury shape, where the two names differ", () => {
    expect(() =>
      validateSpec(
        specWith({
          env: [
            {
              vars: ["MERCURY_TOKEN"],
              local: "authHeader",
              tokenLocal: "apiToken",
              bindings: ["t"],
              auth: "bearer",
            },
          ],
          fetchHelper: {
            local: "mercuryGet",
            base: "https://api.mercury.com",
            baseConst: "BASE",
            headers: "authHeader",
          },
        }),
      ),
    ).not.toThrow();
  });

  // The brief's spec for this pair used a bare `parseSpec(...)` and omitted
  // fetchHelper.headers/.inlineHeaders. Neither works as written: parseSpec() alone never
  // calls validateSpec — only generate() does (src/emit/index.ts:37) — so the collision this
  // test exists to catch would never surface; and style "read-only-kit" is a hand-style per
  // isHandStyle(), which requires exactly one of fetchHelper.headers/.inlineHeaders at the
  // schema level, so the spec would fail to parse for an unrelated reason first. Fixed by
  // wrapping in validateSpec(parseSpec(...)) — the pattern every other test in this file
  // uses via specWith() — and adding inlineHeaders so the spec parses.
  it("rejects a filter export that collides with the fetch helper", () => {
    expect(() =>
      validateSpec(
        parseSpec({
          name: "mercury",
          title: "Mercury",
          displayName: "Mercury",
          description: "d.",
          serviceLabel: "Mercury",
          style: "read-only-kit",
          fetchHelper: {
            local: "mercuryGet",
            base: "https://api.mercury.com",
            inlineHeaders: {},
          },
          tools: [
            {
              name: "s",
              description: "S.",
              impl: "search",
              path: "/v1/x",
              filter: { export: "mercuryGet", fields: ["id"] },
            },
          ],
        }),
      ),
    ).toThrow(/mercuryGet/);
  });

  it.each([
    "fieldsOf",
    "stringField",
    "nestedString",
    "tagText",
    "tagNamesFromObjects",
    "asObjectish",
    "makeQueryFilter",
    "fieldsFromKeys",
  ])("reserves %s against a filter export", (name) => {
    expect(() =>
      validateSpec(
        parseSpec({
          name: "mercury",
          title: "Mercury",
          displayName: "Mercury",
          description: "d.",
          serviceLabel: "Mercury",
          style: "read-only-kit",
          fetchHelper: {
            local: "mercuryGet",
            base: "https://api.mercury.com",
            inlineHeaders: {},
          },
          tools: [
            {
              name: "s",
              description: "S.",
              impl: "search",
              path: "/v1/x",
              filter: { export: name, fields: ["id"] },
            },
          ],
        }),
      ),
    ).toThrow(/reserved/);
  });

  it.each(["u", "URL", "url"])("reserves %s against a fetch helper local", (name) => {
    expect(() =>
      validateSpec(
        parseSpec({
          name: "discord",
          title: "Discord",
          displayName: "Discord",
          description: "d.",
          serviceLabel: "Discord",
          style: "read-only-kit",
          fetchHelper: {
            local: name,
            base: "https://discord.com/api/v10",
            inlineHeaders: {},
          },
          tools: [{ name: "t", description: "T.", path: "/x" }],
        }),
      ),
    ).toThrow(/reserved/);
  });

  /**
   * Task 4 fix round 2: "url" is emitted at function scope by the query branch's absolute-URL
   * passthrough in ALL THREE fetch-helper shapes (rest-kit unconditionally, hand-rolled/
   * read-only-kit's read and write helpers whenever a query tool exists), not only as a
   * fetch helper's own `local`. Pins the two exact collision shapes the reviewer reproduced
   * by hand — an env accessor and a baseConst, not the fetch helper's own name.
   */
  it("rejects an env accessor local named url — the same shape as fetchHelper.local, a different field", () => {
    expect(() =>
      validateSpec(
        parseSpec({
          name: "discord",
          title: "Discord",
          displayName: "Discord",
          description: "d.",
          serviceLabel: "Discord",
          style: "read-only-kit",
          env: [{ vars: ["D_TOKEN"], local: "url", auth: "bearer" }],
          fetchHelper: {
            local: "discordGet",
            base: "https://discord.com/api/v10",
            headers: "url",
          },
          tools: [
            {
              name: "t",
              description: "T.",
              path: "/x",
              args: { q: { type: "string" } },
              query: [{ name: "q", arg: "q" }],
            },
          ],
        }),
      ),
    ).toThrow(/reserved/);
  });

  it("rejects a baseConst named url", () => {
    expect(() =>
      validateSpec(
        parseSpec({
          name: "discord",
          title: "Discord",
          displayName: "Discord",
          description: "d.",
          serviceLabel: "Discord",
          style: "read-only-kit",
          fetchHelper: {
            local: "discordGet",
            base: "https://discord.com/api/v10",
            baseConst: "url",
            inlineHeaders: {},
          },
          tools: [
            {
              name: "t",
              description: "T.",
              path: "/x",
              args: { q: { type: "string" } },
              query: [{ name: "q", arg: "q" }],
            },
          ],
        }),
      ),
    ).toThrow(/reserved/);
  });
});

/**
 * Fix round 1, CRITICAL 1: extractorFilter hardcodes "function fieldsOf", and
 * emitSearchFilter maps it over every tool taking the extractor branch — a connector with two
 * such tools emits two `function fieldsOf(...)` declarations in one module (TS2393, and the
 * second silently wins for both makeQueryFilter calls, since both hoist). Rejected at
 * validateSpec rather than resolved with a spec field to name the extractor or an
 * auto-suffix — see the ruling in src/validate.ts.
 */
describe("at most one extractor-branch search filter per connector", () => {
  function specWithFilters(filters: Record<string, unknown>[]) {
    return parseSpec({
      name: "mercury",
      title: "Mercury",
      displayName: "Mercury",
      description: "d.",
      serviceLabel: "Mercury",
      style: "read-only-kit",
      fetchHelper: {
        local: "mercuryGet",
        base: "https://api.mercury.com",
        inlineHeaders: {},
      },
      tools: filters.map((filter, i) => ({
        name: `s_${i}`,
        description: "S.",
        impl: "search",
        path: `/v1/x${i}`,
        filter,
      })),
    });
  }

  it("rejects two tools that both need the fieldsOf extractor, naming both", () => {
    const spec = specWithFilters([
      { export: "filterA", fields: ["id", { path: ["spec", "source"] }] },
      { export: "filterB", fields: ["name", { tags: "objects" }] },
    ]);
    expect(() => validateSpec(spec)).toThrow(/"s_0"/);
    expect(() => validateSpec(spec)).toThrow(/"s_1"/);
    expect(() => validateSpec(spec)).toThrow(/at most one/);
  });

  it("accepts one extractor-branch tool alongside a keyed tool", () => {
    const spec = specWithFilters([
      { export: "filterA", fields: ["id", { path: ["spec", "source"] }] },
      { export: "filterB", fields: ["id", "name"] },
    ]);
    expect(() => validateSpec(spec)).not.toThrow();
  });

  it("accepts two keyed tools — neither takes the extractor branch", () => {
    const spec = specWithFilters([
      { export: "filterA", fields: ["id"] },
      { export: "filterB", fields: ["name"], tags: true },
    ]);
    expect(() => validateSpec(spec)).not.toThrow();
  });

  it("accepts a single extractor-branch tool", () => {
    const spec = specWithFilters([
      { export: "filterA", fields: ["id", { path: ["spec", "source"] }] },
    ]);
    expect(() => validateSpec(spec)).not.toThrow();
  });
});

/**
 * `rows` names a const the search handler declares, and it was the one field that could collide
 * with `root` and `p` — both already on RESERVED_IDENTIFIERS, `root`'s entry citing this exact
 * emitter — while never being checked against the list.
 */
describe('a search tool\'s "rows"', () => {
  function searchSpec(rows: string, over: Record<string, unknown> = {}) {
    return parseSpec({
      name: "zzrows",
      displayName: "ZZ Rows",
      description: "d.",
      serviceLabel: "ZZ Rows",
      style: "read-only-kit",
      env: [{ vars: ["ZZROWS_TOKEN"], local: "headers", auth: "bearer" }],
      fetchHelper: { local: "zzGet", base: "https://api.zzrows.test", headers: "headers" },
      tools: [
        {
          name: "zz_search",
          description: "S.",
          impl: "search",
          path: "/v1/items",
          rows,
          filter: { export: "zzFilter", fields: ["id"] },
        },
      ],
      ...over,
    });
  }

  it('rejects "root", which the handler already declares one line above', () => {
    // Reproduced before this check existed: `const root = await zzGet("/v1/items");` followed by
    // `const root = (root as { root?: unknown[] } | null)?.root;` — a duplicate `const` in one
    // block that Biome formatted without complaint.
    expect(() => validateSpec(searchSpec("root"))).toThrow(/"root"[\s\S]*reserved/);
  });

  it('rejects "p", the handler parameter', () => {
    expect(() => validateSpec(searchSpec("p"))).toThrow(/"p"[\s\S]*reserved/);
  });

  it("rejects the fetch helper's own name, which the declaration would shadow", () => {
    expect(() => validateSpec(searchSpec("zzGet"))).toThrow(/zzGet/);
  });

  it("accepts an ordinary envelope key", () => {
    expect(() => validateSpec(searchSpec("items"))).not.toThrow();
  });

  it("lets two search tools use the SAME rows name, since each is function-scoped", () => {
    // fixtures/zzextract.spec.json does exactly this. Claiming `rows` in the shared map — the
    // obvious fix, and the one the review suggested — would reject that fixture.
    const spec = parseSpec({
      name: "zzrows",
      displayName: "ZZ Rows",
      description: "d.",
      serviceLabel: "ZZ Rows",
      style: "read-only-kit",
      env: [{ vars: ["ZZROWS_TOKEN"], local: "headers", auth: "bearer" }],
      fetchHelper: { local: "zzGet", base: "https://api.zzrows.test", headers: "headers" },
      tools: [0, 1].map((i) => ({
        name: `zz_search_${i}`,
        description: "S.",
        impl: "search",
        path: `/v1/items${i}`,
        rows: "items",
        filter: { export: `zzFilter${i}`, fields: ["id"] },
      })),
    });
    expect(() => validateSpec(spec)).not.toThrow();
  });
});

/**
 * Four emitted names are built by wrapping the stripped title. Stripping rescues a two-word
 * title; it cannot rescue one that starts with a digit or has no alphanumeric character at all.
 */
describe("the identifier derived from title", () => {
  it("accepts a two-word title, which strips to a usable identifier", () => {
    expect(() => validateSpec(specWith({ title: "Google Meet" }))).not.toThrow();
  });

  it("rejects a title starting with a digit, which stripping cannot rescue", () => {
    expect(() => validateSpec(specWith({ title: "1Password" }))).toThrow(/"1Password"/);
  });

  it("rejects a title with no alphanumeric character, which strips to nothing", () => {
    // Emits `export type SearchMatchOptions = SearchMatchOptions;` — a circular alias, TS2456.
    expect(() => validateSpec(specWith({ title: "!!!" }))).toThrow(/""/);
  });

  it("checks the DEFAULTED title too, which is the half a user never writes", () => {
    // parseSpec fills `title` from capitalize(spec.name), so a refine on the optional field
    // would leave this case unchecked. `name` is lower-kebab, so this needs a leading digit.
    expect(() => validateSpec(specWith({ name: "1password", title: undefined }))).toThrow(
      /1password/,
    );
  });
});

/**
 * `bindings` had the injection guard (`identifierField()`, so no executable payload reaches the
 * `const`) and not the collision guard — `readLines` declares the binding inside an accessor body
 * that also reads module-scope declarations and globals, and nothing compared the two.
 */
describe("an env entry's bindings", () => {
  function envSpec(entry: Record<string, unknown>) {
    return parseSpec({
      name: "zzbind",
      displayName: "ZZ Bind",
      description: "d.",
      serviceLabel: "ZZ Bind",
      style: "hand-rolled",
      env: [{ ...entry }, { vars: ["ZZBIND_TOKEN"], local: "headers", auth: "bearer" }],
      fetchHelper: { local: "zzGet", base: "https://api.zzbind.test", headers: "headers" },
      tools: [],
    });
  }

  it('rejects "process", whose read line would initialise the const from itself', () => {
    // `const process = process.env["ZZBIND_V"]?.trim();` — TS7022 + TS2448.
    expect(() =>
      validateSpec(
        envSpec({ vars: ["ZZBIND_V"], local: "v", required: true, bindings: ["process"] }),
      ),
    ).toThrow(/"const process"[\s\S]*already references "process"/);
  });

  it('rejects "trimTrailingSlash" on the entry whose transform CALLS it', () => {
    // `return trimTrailingSlash(trimTrailingSlash);` — TS2349.
    expect(() =>
      validateSpec(
        envSpec({
          vars: ["ZZBIND_URL"],
          local: "v",
          required: true,
          transform: "trimTrailingSlashFn",
          bindings: ["trimTrailingSlash"],
        }),
      ),
    ).toThrow(/trimTrailingSlash/);
  });

  it('rejects "cachedToken" on a client-credentials entry, read one line above the const', () => {
    // Declared inside `async function token()` below `if (cachedToken !== null && …)` — TS2448,
    // and TS2588 for the `cachedToken = parsed.access_token` assignment to a const.
    expect(() =>
      validateSpec(
        envSpec({
          vars: ["ZZBIND_ID", "ZZBIND_SECRET"],
          local: "v",
          auth: "client-credentials",
          tokenUrl: "https://api.zzbind.test/oauth/token",
          credentialsIn: "basic",
          bindings: ["id", "cachedToken"],
        }),
      ),
    ).toThrow(/cachedToken/);
  });

  it('rejects "undefined", which typechecks and then throws on every call', () => {
    // The one in this set no compiler sees. The guard becomes `if (undefined === undefined || …)`
    // — the const compared with itself — so the accessor reports "ZZBIND_V is not set" however it
    // is configured. Confirmed by running the emitted accessor.
    expect(() =>
      validateSpec(
        envSpec({ vars: ["ZZBIND_V"], local: "v", auth: "bearer", bindings: ["undefined"] }),
      ),
    ).toThrow(/undefined/);
  });

  it('rejects "res", a const the token exchange declares further down the same block', () => {
    expect(() =>
      validateSpec(
        envSpec({
          vars: ["ZZBIND_ID", "ZZBIND_SECRET"],
          local: "v",
          auth: "client-credentials",
          tokenUrl: "https://api.zzbind.test/oauth/token",
          credentialsIn: "body",
          bindings: ["res", "secret"],
        }),
      ),
    ).toThrow(/"res"/);
  });

  it('accepts "u", which four fixtures use and a shared-map check would reject', () => {
    // grafana, sentry, zzscratch and zzstandalonehand all write bindings: ["u"], and "u" is on
    // RESERVED_IDENTIFIERS for the conditional-query branch's URL const. Two of the four are
    // byte-locked. Checking `bindings` against `seen` — the obvious fix — breaks all four.
    expect(() =>
      validateSpec(
        envSpec({
          vars: ["ZZBIND_URL"],
          local: "v",
          required: true,
          transform: "stripTrailingSlash",
          bindings: ["u"],
        }),
      ),
    ).not.toThrow();
  });

  it('accepts "token" on a BASIC entry, which is what zendesk writes', () => {
    // Nothing named `token` is emitted anywhere in renderBasic's output. `token` is reserved at
    // module scope for the client-credentials branch, which this entry is not.
    expect(() =>
      validateSpec(
        envSpec({
          vars: ["ZZBIND_EMAIL", "ZZBIND_TOKEN"],
          local: "v",
          auth: "basic",
          bindings: ["email", "token"],
        }),
      ),
    ).not.toThrow();
  });

  it('accepts "token" on the client-credentials entry too, and states why', () => {
    // `renderTokenFunction` names the enclosing function `token`, and that function's body never
    // calls it — only the wrapper accessor beneath it does, from another scope. Compiled clean
    // under tsc --strict. Refusing it would need a reason that is not true; the reproduction that
    // named it, ["token", "cachedToken"], fails on the second name.
    expect(() =>
      validateSpec(
        envSpec({
          vars: ["ZZBIND_ID", "ZZBIND_SECRET"],
          local: "v",
          auth: "client-credentials",
          tokenUrl: "https://api.zzbind.test/oauth/token",
          credentialsIn: "body",
          bindings: ["token", "secret"],
        }),
      ),
    ).not.toThrow();
  });

  it('rejects "encodeBasicAuthHeader" for credentialsIn "basic" and accepts it for "body"', () => {
    // The rule is entry-scoped down to `credentialsIn`. The basic form splices the binding into
    // `Authorization: encodeBasicAuthHeader(id, secret)`; the body form puts the credentials in
    // the form body and emits no call at all, so there is nothing there to shadow.
    const cc = (credentialsIn: string, bindings: string[]) =>
      envSpec({
        vars: ["ZZBIND_ID", "ZZBIND_SECRET"],
        local: "v",
        auth: "client-credentials",
        tokenUrl: "https://api.zzbind.test/oauth/token",
        credentialsIn,
        bindings,
      });
    expect(() => validateSpec(cc("basic", ["encodeBasicAuthHeader", "secret"]))).toThrow(
      /encodeBasicAuthHeader/,
    );
    expect(() => validateSpec(cc("body", ["encodeBasicAuthHeader", "secret"]))).not.toThrow();
  });
});
