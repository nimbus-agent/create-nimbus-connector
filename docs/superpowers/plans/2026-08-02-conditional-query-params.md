# Conditional query parameters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tool declare query parameters that are omitted when their argument is absent, so the six corpus connectors writing the `URL` + `searchParams` shape stop being stubbed.

**Architecture:** A new optional `query` array on `ToolSchema`. Rendering is *derived*: a tool without `query` emits today's path expression byte-for-byte; a tool with `query` emits a block that builds an absolute `URL`, sets each parameter, and returns `` `${u.pathname}${u.search}` ``. The rendering lives in one new module both the rest-kit and hand-rolled tool renderers call, so the two cannot disagree.

**Tech Stack:** Bun, TypeScript, zod 4 (`^4.4.2`), Biome 2.5.6, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-08-02-conditional-query-params-design.md`

## Global Constraints

- **Bun only.** No Node, npm or pnpm path. Tests import `bun:test`.
- **No connector source, and no `shared/` source, may be copied from Nimbus into this repository** — not into `src/`, `test/` or `fixtures/`. Fixture specs are hand-written from the API shape. `CLAUDE.md`'s one carve-out is description strings, which are required for byte-matching; it does not extend to code.
- **Emitters return UNFORMATTED source.** `generate()` is pure; output goes through `formatAll()`, which runs the real Biome. Never hand-align indentation. Do hand-manage line breaks.
- **The byte-safety invariant:** `newrelic`, `datadog`, `grafana` and `sentry` reproduce 6/6 and must stay there. They declare no `query`, so they cannot reach the new branch — verify with `diff:golden` after every emitter change.
- **`fixtures/expectations.json` is never edited to hide a mismatch.** The harness fails in both directions: matching *more* files than declared is an "improved" failure. An entry lists exactly what matches.
- **Never commit on `main`.** This work happens on `worktree-stage-e-reach`.
- **Conventional Commits.** `feat:` bumps the minor, `fix:` the patch.
- Comments explain **why**, and cite the corpus measurement behind a choice where one exists.
- Nimbus checkout for local gates: `C:/gitrep/Nimbus`.

---

### Task 1: Spec schema — the `query` array

**Files:**
- Modify: `src/spec.ts` (add `QueryParamSchema`, extend `ToolSchema`)
- Test: `test/spec.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `QueryParam` type and `tool.query`. Later tasks rely on exactly:
  - `QueryParam = { name: string; arg: string; omitWhen?: "empty" }`
  - `tool.query?: QueryParam[]` — a **mutable** array, because that is what `z.array()` infers. Do not add `.readonly()`.

- [ ] **Step 1: Write the failing tests**

Add to `test/spec.test.ts`:

```ts
describe("ToolSchema query parameters", () => {
  const withQuery = (tool: Record<string, unknown>) =>
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
        inlineHeaders: { Accept: "application/json" },
      },
      tools: [{ name: "t", description: "T.", path: "/messages", ...tool }],
    });

  it("accepts an unconditional and a conditional parameter", () => {
    const spec = withQuery({
      args: { limit: { type: "number" }, after: { type: "string", optional: true } },
      query: [
        { name: "limit", arg: "limit" },
        { name: "after", arg: "after", omitWhen: "empty" },
      ],
    });
    expect(spec.tools[0]!.query).toEqual([
      { name: "limit", arg: "limit" },
      { name: "after", arg: "after", omitWhen: "empty" },
    ]);
  });

  it("accepts a query key that is not a JS identifier", () => {
    const spec = withQuery({
      args: { limit: { type: "number" } },
      query: [{ name: "page[size]", arg: "limit" }],
    });
    expect(spec.tools[0]!.query![0]!.name).toBe("page[size]");
  });

  it("rejects an omitWhen value other than empty", () => {
    expect(() =>
      withQuery({
        args: { after: { type: "string", optional: true } },
        query: [{ name: "after", arg: "after", omitWhen: "absent" }],
      }),
    ).toThrow();
  });

  it("rejects a query arg that is not declared", () => {
    expect(() =>
      withQuery({ args: {}, query: [{ name: "after", arg: "after" }] })).toThrow(/"after"/);
  });

  it("rejects two entries writing the same query key", () => {
    expect(() =>
      withQuery({
        args: { a: { type: "string" }, b: { type: "string" } },
        query: [
          { name: "limit", arg: "a" },
          { name: "limit", arg: "b" },
        ],
      }),
    ).toThrow(/"limit"/);
  });

  it("rejects query on a stub tool", () => {
    expect(() =>
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
          inlineHeaders: { Accept: "application/json" },
        },
        tools: [
          {
            name: "t",
            description: "T.",
            impl: "stub",
            args: { after: { type: "string" } },
            query: [{ name: "after", arg: "after" }],
          },
        ],
      }),
    ).toThrow(/query/);
  });

  it("rejects query when the path already carries a query string", () => {
    expect(() =>
      withQuery({
        path: "/messages?limit=50",
        args: { after: { type: "string" } },
        query: [{ name: "after", arg: "after" }],
      }),
    ).toThrow(/\?/);
  });

  it("rejects an empty query array", () => {
    expect(() => withQuery({ args: {}, query: [] })).toThrow();
  });

  it("leaves a tool with no query untouched", () => {
    const spec = withQuery({ args: {} });
    expect(spec.tools[0]!.query).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/spec.test.ts`
Expected: FAIL — `query` is not a known key, so `z.strictObject` rejects every case.

- [ ] **Step 3: Implement the schema**

Add above `ToolSchema` in `src/spec.ts`:

```ts
/**
 * One query-string parameter. `name` is the key as the API spells it and is deliberately not
 * an identifier check — `page[size]` is a real corpus key.
 *
 * `omitWhen` is a single-valued enum rather than a boolean because the guard it selects is a
 * specific predicate (`!== undefined && !== ""`), not a yes/no. A second predicate, if the
 * corpus ever shows one, becomes another value here rather than a second boolean field.
 */
export const QueryParamSchema = z.strictObject({
  name: z.string().min(1),
  arg: z.string().min(1),
  omitWhen: z.literal("empty").optional(),
});

export type QueryParam = z.infer<typeof QueryParamSchema>;
```

Add to `ToolSchema`'s `strictObject` body, beside `path`:

```ts
    query: z.array(QueryParamSchema).min(1, "a query must declare at least one parameter").optional(),
```

Append these refinements to `ToolSchema`, after the existing ones:

```ts
  .refine((t) => !(t.impl === "stub" && t.query !== undefined), {
    message: 'a "stub" tool issues no request, so "query" has nothing to describe',
  })
  .refine((t) => !(t.query !== undefined && (t.path ?? "").includes("?")), {
    message:
      '"query" and a "?" inside "path" both write the query string — use one. A tool that ' +
      "needs \"query\" moves its whole query string there.",
  })
  .superRefine((t, ctx) => {
    if (t.query === undefined) return;
    const seen = new Set<string>();
    for (const [i, q] of t.query.entries()) {
      if (!(q.arg in t.args)) {
        ctx.addIssue({
          code: "custom",
          path: ["query", i, "arg"],
          message: `"query" entry ${JSON.stringify(q.name)} names arg ${JSON.stringify(q.arg)}, which the tool does not declare`,
        });
      }
      if (seen.has(q.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["query", i, "name"],
          message: `"query" declares ${JSON.stringify(q.name)} twice — the second would silently win`,
        });
      }
      seen.add(q.name);
    }
  })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/spec.test.ts && bun test && bunx tsc --noEmit`
Expected: PASS. `tsc` may report an error in an emitter file if it narrows on `ToolSpec` keys; if so, that file belongs to Task 4 — leave it and note it.

- [ ] **Step 5: Commit**

```bash
git add src/spec.ts test/spec.test.ts
git commit -m "feat(spec): accept a query array on a tool"
```

---

### Task 2: Identifier safety

**Files:**
- Modify: `src/validate.ts` (`RESERVED_IDENTIFIERS`)
- Test: `test/validate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks call. Task 5 and 6 fixtures must not use `u` or `URL` as an identifier.

- [ ] **Step 1: Write the failing test**

Add to `test/validate.test.ts`, inside the existing reserved-identifier describe block:

```ts
it.each(["u", "URL"])("reserves %s against a fetch helper local", (name) => {
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/validate.test.ts`
Expected: FAIL — neither name is reserved yet, so the spec validates.

- [ ] **Step 3: Implement**

Append to `RESERVED_IDENTIFIERS` in `src/validate.ts`, before the closing `];`:

```ts
  // The conditional-query branch emits `const u = new URL(...)` inside the path callback and
  // calls the URL global directly. `u` is function-scope rather than module-scope, which is
  // exactly the case "root" above is reserved for: a fetch helper named `u` would produce a
  // use-before-declaration, not a shadow. Corpus note: the URL local's name is genuinely split
  // (search x23, u x20, params x15, qs x10), and `u` is chosen because it is what discord and
  // google-meet write — the two connectors this branch exists to reproduce.
  "u",
  "URL",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS. If an existing fixture now fails to parse, that is a real finding — report it rather than removing the reserved entry.

- [ ] **Step 5: Commit**

```bash
git add src/validate.ts test/validate.test.ts
git commit -m "fix(validate): reserve u and URL for the query branch"
```

---

### Task 3: The query renderer

**Files:**
- Create: `src/emit/server/query.ts`
- Modify: `src/emit/server/path-template.ts` (add an optional `prefix` to `RenderContext`)
- Test: `test/emit/server/query.test.ts`

**Interfaces:**
- Consumes: `QueryParam` from `src/spec.ts` (Task 1).
- Produces, relied on by Task 4:
  - `renderQueryLines(query: readonly QueryParam[], ctx: { param: string; hoisted: Map<string, string> }): string[]` — the `searchParams` statements, unindented, one array element per line.
  - `queryArgsUsed(query: readonly QueryParam[], hoisted: Map<string, string>): Set<string>` — hoisted arg names the query references, for the caller's `used` set.
  - `renderPath`'s `RenderContext` gains `prefix?: string`. When present, `renderPath` **always** returns a template literal beginning with that prefix.

**Why a `prefix` rather than string concatenation:** `renderPath` returns a template literal for a dynamic path but a JSON string (`"/users/@me/guilds"`) for a static one. Textually gluing a base onto either form means the caller re-implements that distinction. Threading a prefix keeps one renderer, the same reasoning that gives `fetch-helper.ts` its single `baseExpr`.

- [ ] **Step 1: Write the failing tests**

Create `test/emit/server/query.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parsePathTemplate, renderPath } from "../../../src/emit/server/path-template.ts";
import { queryArgsUsed, renderQueryLines } from "../../../src/emit/server/query.ts";

const NO_HOISTS = new Map<string, string>();

describe("renderQueryLines", () => {
  it("sets an unconditional parameter through String()", () => {
    expect(renderQueryLines([{ name: "limit", arg: "limit" }], { param: "parsed", hoisted: NO_HOISTS })).toEqual([
      'u.searchParams.set("limit", String(parsed.limit));',
    ]);
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
    expect(renderQueryLines([{ name: "limit", arg: "limit" }], { param: "parsed", hoisted })).toEqual([
      'u.searchParams.set("limit", String(lim));',
    ]);
  });

  it("quotes a key that is not a JS identifier", () => {
    expect(renderQueryLines([{ name: "page[size]", arg: "limit" }], { param: "parsed", hoisted: NO_HOISTS })).toEqual([
      'u.searchParams.set("page[size]", String(parsed.limit));',
    ]);
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
    expect(renderPath(segments, { param: "parsed", hoisted: NO_HOISTS, prefix: "${MEET_BASE}" })).toBe(
      "`${MEET_BASE}/conferenceRecords`",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/emit/server/query.test.ts`
Expected: FAIL — `src/emit/server/query.ts` does not exist.

- [ ] **Step 3: Implement `renderPath`'s prefix**

In `src/emit/server/path-template.ts`, add to the `RenderContext` type:

```ts
  /**
   * Emitted at the start of the template, before the first segment. The conditional-query
   * branch passes the fetch helper's base here so `new URL(...)` receives an absolute URL —
   * `new URL("/relative")` throws. Threading it through the one path renderer keeps the
   * template-vs-JSON-string distinction in a single place.
   */
  readonly prefix?: string;
```

Replace `renderPath`'s body's first branch so a prefix forces the template form:

```ts
export function renderPath(segments: readonly PathSegment[], ctx: RenderContext): string {
  const prefix = ctx.prefix ?? "";
  const dynamic = segments.some((s) => s.kind !== "literal");
  if (!dynamic && prefix === "") {
    const text = segments.map((s) => (s.kind === "literal" ? s.text : "")).join("");
    if (ctx.staticStyle === "template") {
      return `\`${text.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;
    }
    return JSON.stringify(text);
  }
  const body = segments
    .map((s) => {
      if (s.kind === "literal") return s.text.replaceAll("\\", "\\\\").replaceAll("`", "\\`");
      if (s.kind === "env") return `\${${s.name}()}`;
      return `\${${argExpression(s, ctx)}}`;
    })
    .join("");
  return `\`${prefix}${body}\``;
}
```

- [ ] **Step 4: Implement `query.ts`**

Create `src/emit/server/query.ts`:

```ts
import type { QueryParam } from "../../spec.ts";

export type QueryContext = {
  readonly param: string;
  readonly hoisted: Map<string, string>;
};

/** The expression that reads one query entry's value — the hoisted const, or the parameter. */
function valueExpr(q: QueryParam, ctx: QueryContext): string {
  return ctx.hoisted.get(q.arg) ?? `${ctx.param}.${q.arg}`;
}

/**
 * The `searchParams` statements for one tool, unindented — the caller owns indentation because
 * the rest-kit and hand-rolled callbacks nest them at different depths.
 *
 * An unconditional value is wrapped in `String(...)`; a guarded one is not. That asymmetry is
 * the corpus's, not a choice: an unconditional entry may carry a number (`limit`), while every
 * guarded entry in the six in-scope connectors is a string already, and wrapping it would emit
 * `String(parsed.after)` where the real file writes `parsed.after`.
 */
export function renderQueryLines(query: readonly QueryParam[], ctx: QueryContext): string[] {
  const lines: string[] = [];
  for (const q of query) {
    const key = JSON.stringify(q.name);
    const value = valueExpr(q, ctx);
    if (q.omitWhen === undefined) {
      lines.push(`u.searchParams.set(${key}, String(${value}));`);
      continue;
    }
    lines.push(`if (${value} !== undefined && ${value} !== "") {`);
    lines.push(`  u.searchParams.set(${key}, ${value});`);
    lines.push("}");
  }
  return lines;
}

/** Hoisted arg names this query reads, so the caller emits exactly the hoists something uses. */
export function queryArgsUsed(
  query: readonly QueryParam[],
  hoisted: Map<string, string>,
): Set<string> {
  const used = new Set<string>();
  for (const q of query) {
    if (hoisted.has(q.arg)) used.add(q.arg);
  }
  return used;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/emit/server/query.test.ts && bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/`
Expected: PASS.

- [ ] **Step 6: Confirm the byte-safety invariant**

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: unchanged — nothing calls the new module yet, and `prefix` is optional so every existing `renderPath` call behaves identically. `newrelic`/`datadog`/`grafana`/`sentry` `6/6`.

- [ ] **Step 7: Commit**

```bash
git add src/emit/server/query.ts src/emit/server/path-template.ts test/emit/server/query.test.ts
git commit -m "feat(emit): render conditional query parameters"
```

---

### Task 4: Wire the query branch into both tool renderers

**Files:**
- Modify: `src/emit/server/tools-rest.ts`
- Modify: `src/emit/server/tools-hand.ts`
- Modify: `src/emit/server/fetch-helper.ts` (export `baseExpr`)
- Test: `test/emit/server/tools-rest.test.ts`, `test/emit/server/tools-hand.test.ts`, `test/emit/emitted-typecheck.test.ts`

**Interfaces:**
- Consumes: `renderQueryLines`, `queryArgsUsed` (Task 3); `renderPath`'s `prefix` (Task 3); `tool.query` (Task 1).
- Produces: no new exports. `baseExpr(spec: ConnectorSpec): string` becomes exported from `fetch-helper.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `test/emit/server/tools-rest.test.ts` (create the describe if the file has none for this):

```ts
it("emits the URL block for a tool declaring query parameters", () => {
  const spec = parseSpec({
    name: "discord",
    title: "Discord",
    displayName: "Discord",
    description: "d.",
    serviceLabel: "Discord",
    style: "rest-kit",
    env: [{ vars: ["DISCORD_TOKEN"], local: "token", auth: "bearer" }],
    fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10", baseConst: "DISCORD_API" },
    tools: [
      {
        name: "discord_channel_messages",
        description: "List recent messages.",
        path: "/channels/${arg.channelId|enc}/messages",
        args: {
          channelId: { type: "string", min: 1 },
          limit: { type: "number", optional: true, default: 50, local: "lim" },
          after: { type: "string", optional: true },
        },
        query: [
          { name: "limit", arg: "limit" },
          { name: "after", arg: "after", omitWhen: "empty" },
        ],
      },
    ],
  });
  const out = renderRestKitTools(spec);
  expect(out).toContain("const lim = parsed.limit ?? 50;");
  expect(out).toContain(
    "const u = new URL(`${DISCORD_API}/channels/${encodeURIComponent(parsed.channelId)}/messages`);",
  );
  expect(out).toContain('u.searchParams.set("limit", String(lim));');
  expect(out).toContain('if (parsed.after !== undefined && parsed.after !== "") {');
  expect(out).toContain("return `${u.pathname}${u.search}`;");
});

it("leaves a tool with no query on the unchanged path branch", () => {
  const spec = parseSpec({
    name: "discord",
    title: "Discord",
    displayName: "Discord",
    description: "d.",
    serviceLabel: "Discord",
    style: "rest-kit",
    env: [{ vars: ["DISCORD_TOKEN"], local: "token", auth: "bearer" }],
    fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
    tools: [{ name: "t", description: "T.", path: "/users/@me/guilds" }],
  });
  const out = renderRestKitTools(spec);
  expect(out).not.toContain("new URL(");
  expect(out).toContain('() => "/users/@me/guilds",');
});
```

Add the equivalent pair to `test/emit/server/tools-hand.test.ts`, using `style: "read-only-kit"`, `inlineHeaders: { Accept: "application/json" }` instead of `env`/`baseConst`, and asserting the same five emitted substrings plus that the handler still wraps in `jsonResult(await discordGet(...))`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/emit/server/`
Expected: FAIL — `query` is parsed but ignored, so no `new URL(` appears.

- [ ] **Step 3: Export `baseExpr`**

In `src/emit/server/fetch-helper.ts`, change `function baseExpr(` to `export function baseExpr(`. Leave its body and doc comment untouched — its point is that every call site agrees, and the query branch is now a fourth caller.

- [ ] **Step 4: Implement the rest-kit branch**

In `src/emit/server/tools-rest.ts`, add the imports:

```ts
import { baseExpr } from "./fetch-helper.ts";
import { queryArgsUsed, renderQueryLines } from "./query.ts";
```

Replace the block from `const pathExpr = renderPath(...)` through the final `return lines.join("\n");` with:

```ts
  const query = tool.query;
  const pathExpr = renderPath(segments, {
    param: PARAM,
    hoisted,
    staticStyle: spec.fetchHelper.staticPathStyle,
    ...(query === undefined ? {} : { prefix: baseExpr(spec) }),
  });

  // Only the path can consume a hoist here: the hoists are emitted inside the path callback,
  // and the init callback below is a separate arrow with its own scope. A hoisted const no
  // path segment names would be a TS6133 in the generated package — reachable from a
  // rest-kit POST with one boolean arg and a fully static path.
  const used = new Set<string>();
  for (const s of segments) {
    if (s.kind === "arg" && hoisted.has(s.name)) used.add(s.name);
  }
  // A query entry reads the same hoisted const the path would, so its args join `used` or the
  // hoist is never emitted and the reference dangles.
  if (query !== undefined) {
    for (const name of queryArgsUsed(query, hoisted)) used.add(name);
  }

  const needsParam =
    used.size > 0 ||
    segments.some((s) => s.kind === "arg" && !hoisted.has(s.name)) ||
    (query ?? []).some((q) => !hoisted.has(q.arg));
  const param = needsParam ? `(${PARAM})` : "()";

  // Empty `hoisted`, deliberately: nothing the path callback declares is in scope inside the
  // init callback, so renderBodyExpr inlines any `?? default` itself rather than naming a
  // const that does not exist there. The value is identical to the path's.
  const body = renderBodyExpr(tool, { param: PARAM, hoisted: new Map() });
  const bodyExpr = body?.expr;
  const initParam = bodyExpr === undefined ? "()" : `(${PARAM})`;
  const bodyPart = bodyExpr === undefined ? "" : `, body: ${bodyExpr}`;
  const initArg =
    tool.method === "GET"
      ? undefined
      : `  ${initParam} => ({ method: ${JSON.stringify(tool.method)}${bodyPart} }),`;

  if (query !== undefined) {
    const hoists = renderHoists(tool.args, PARAM, used).map((l) => `    ${l}`);
    const queryLines = renderQueryLines(query, { param: PARAM, hoisted }).map((l) => `    ${l}`);
    const lines = [
      ...head,
      `  ${param} => {`,
      ...hoists,
      `    const u = new URL(${pathExpr});`,
      ...queryLines,
      "    return `${u.pathname}${u.search}`;",
      "  },",
    ];
    if (initArg !== undefined) lines.push(initArg);
    lines.push(");");
    return lines.join("\n");
  }

  if (used.size === 0) {
    const lines = [...head, `  ${param} => ${pathExpr},`];
    if (initArg !== undefined) lines.push(initArg);
    lines.push(");");
    return lines.join("\n");
  }

  const hoists = renderHoists(tool.args, PARAM, used).map((l) => `    ${l}`);
  const lines = [...head, `  ${param} => {`, ...hoists, `    return ${pathExpr};`, "  },"];
  if (initArg !== undefined) lines.push(initArg);
  lines.push(");");
  return lines.join("\n");
```

- [ ] **Step 5: Implement the hand-rolled branch**

In `src/emit/server/tools-hand.ts`, add the same two imports, pass the same conditional `prefix` into its `renderPath` call, and add the same `queryArgsUsed` contribution to its `used` set.

**The method matters here, and getting it wrong is silent.** That file already builds its call with a GET/non-GET split:

```ts
  const call =
    tool.method === "GET"
      ? `jsonResult(await ${spec.fetchHelper.local}(${pathExpr}))`
      : `jsonResult(await ${spec.fetchHelper.local}Send(${pathExpr}, ${JSON.stringify(tool.method)}, ${bodyExpr ?? "undefined"}))`;
```

A `query` tool is not necessarily a GET — the schema rejects `query` only on a stub, and a POST carrying query parameters is an ordinary API shape. **Do not write a second call expression for the query branch.** Change only what the path is, leaving the existing split to decide the helper:

```ts
  // With a query the path is the `path` const the block below declares, not the inline
  // expression — but WHICH helper receives it is still the method's decision. Substituting
  // the path rather than duplicating the ternary is what keeps a non-GET query tool from
  // silently routing through the read helper.
  const callPath = tool.query === undefined ? pathExpr : "path";
  const call =
    tool.method === "GET"
      ? `jsonResult(await ${spec.fetchHelper.local}(${callPath}))`
      : `jsonResult(await ${spec.fetchHelper.local}Send(${callPath}, ${JSON.stringify(tool.method)}, ${bodyExpr ?? "undefined"}))`;
```

Then, when `tool.query !== undefined`, the handler body gains these statements before the call, alongside the hoists and indented the way that file already indents handler statements:

```ts
    const queryLines = renderQueryLines(query, { param: PARAM, hoisted });
    const inner = [
      `const u = new URL(${pathExpr});`,
      ...queryLines,
      "const path = `${u.pathname}${u.search}`;",
      `return ${call};`,
    ];
```

`path` is a named local rather than an inline template because the hand-rolled call site passes the path as a call argument, and a nested template literal inside an argument list reads poorly.

**Add a test for the non-GET case** in `test/emit/server/tools-hand.test.ts`, asserting that a `POST` tool declaring `query` emits `<local>Send(path, "POST", …)` and not `<local>(path)`. Without it nothing pins the distinction, and the failure mode is a wrong HTTP method rather than a compile error.

**`path` is already reserved** — `src/validate.ts:15`, verified while writing this plan — so declaring `const path` here needs no new entry. Do not remove or re-add it.

- [ ] **Step 6: Add the emitted-typecheck case**

In `test/emit/emitted-typecheck.test.ts`, add a case to the describe block that compiles a real emitted `src/server.ts` for a `read-only-kit` spec with one tool carrying both an unconditional and a conditional query parameter, following the existing cases' shape exactly. This is the only CI-runnable gate that compiles the emitted `URL`/`searchParams` shape rather than string-matching it.

- [ ] **Step 7: Run every gate**

Run:
```
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
```
Expected: all PASS. `newrelic`/`datadog`/`grafana`/`sentry` still `6/6`; `mercury`/`zendesk` `6/7`; `dependencytrack` `5/7`; `netlify` `4/7`; `discord` `3/6`; `google-meet` `2/6`. **No fixture may move in this task** — none declares `query` yet. If one moves, the gating is wrong; stop and report.

- [ ] **Step 8: Commit**

```bash
git add src/emit/server/ test/emit/
git commit -m "feat(emit): emit the URL and searchParams block for query tools"
```

---

### Task 5: The `discord` fixture — the byte proof

**Files:**
- Modify: `fixtures/discord.spec.json`
- Modify: `fixtures/expectations.json`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: the demonstration that the emitted block matches a real connector.

- [ ] **Step 1: Read the real connector**

Read `C:/gitrep/Nimbus/packages/mcp-connectors/discord/src/server.ts`. The target handler is `discord_channel_messages`. Note that it hoists `const lim = parsed.limit ?? 50;` — `lim` is the arg's `local`.

**Do not copy source into this repository.** The spec is hand-written; only description strings are reproduced, per `CLAUDE.md`'s carve-out.

- [ ] **Step 2: Convert the stubbed tool**

In `fixtures/discord.spec.json`, replace the `discord_channel_messages` stub with a real tool:

```jsonc
{
  "name": "discord_channel_messages",
  "description": "<the real connector's description string, verbatim>",
  "path": "/channels/${arg.channelId|enc}/messages",
  "args": {
    "channelId": { "type": "string", "min": 1 },
    "limit": { "type": "number", "int": true, "min": 1, "max": 100, "optional": true, "default": 50, "local": "lim" },
    "after": { "type": "string", "optional": true }
  },
  "query": [
    { "name": "limit", "arg": "limit" },
    { "name": "after", "arg": "after", "omitWhen": "empty" }
  ]
}
```

Also add `"baseConst": "DISCORD_API"` to the fixture's `fetchHelper`. Without it, `baseExpr` inlines the literal where the real connector writes `${DISCORD_API}`, and `src/server.ts` cannot match.

- [ ] **Step 3: Run the harness and read what actually changed**

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: `FAIL discord` — its declared expectation no longer matches what is produced, in one direction or the other.

Read the reported `gained` and `lost` lists. **That report is the new expectation entry**, not what you hoped for.

- [ ] **Step 4: Record the expectation honestly**

Update `discord`'s entry in `fixtures/expectations.json` to exactly the files the harness reports as identical. If `src/server.ts` now matches, add it. If it does not, leave it out and **write down in your report the first differing line and why** — that is a finding about the design, not a fixture to be massaged.

`fixtures/expectations.json` is never edited toward a hoped-for result.

- [ ] **Step 5: Verify**

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus && bun test && bunx tsc --noEmit`
Expected: `PASS discord`, all four locked fixtures still `6/6`, every other fixture unmoved.

- [ ] **Step 6: Commit**

```bash
git add fixtures/discord.spec.json fixtures/expectations.json
git commit -m "test(golden): discord's message tool stops being a stub"
```

---

### Task 6: The `google-meet` fixture — and the documented gap

**Files:**
- Modify: `fixtures/google-meet.spec.json`
- Modify: `fixtures/expectations.json`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: the second and third stubbed tools converted, and evidence for the inline-default limitation.

- [ ] **Step 1: Convert both stubbed tools**

Read `C:/gitrep/Nimbus/packages/mcp-connectors/google-meet/src/server.ts`. Convert `google_meet_list` and `google_meet_search` from stubs to real tools. Both have path `/conferenceRecords`; `google_meet_list` declares `pageSize` and `pageToken`; `google_meet_search` adds `filter`. Every optional string parameter is `omitWhen: "empty"`.

The real connector inlines its default — `u.searchParams.set("pageSize", String(parsed.pageSize ?? 50))` — so give `pageSize` a `default` and expect the emitter to hoist it instead. **This is the expected mismatch**, not a bug to chase.

- [ ] **Step 2: Run the harness, record what it says**

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`

Update `google-meet`'s `fixtures/expectations.json` entry to exactly the reported identical set.

- [ ] **Step 3: Confirm the gap is the one predicted**

Read the `src/server.ts` diff for `google-meet`. Confirm the difference is the hoisted-versus-inlined default and **nothing else**. If there is a second, unpredicted difference, that is a design finding — report it rather than absorbing it.

- [ ] **Step 4: Verify**

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus && bun test`
Expected: `PASS google-meet`, all four locked fixtures `6/6`, `discord` at whatever Task 5 established.

- [ ] **Step 5: Commit**

```bash
git add fixtures/google-meet.spec.json fixtures/expectations.json
git commit -m "test(golden): google-meet's two search tools stop being stubs"
```

---

### Task 7: Documentation and full preflight

**Files:**
- Modify: `docs/ROADMAP.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README — document `query`**

Add `query` to the tool-spec reference beside `path`: the three fields, that `omitWhen: "empty"` guards on `!== undefined && !== ""`, that `searchParams` percent-encodes so query values take no encoding mode, that defaults live on the argument, and the four rejections. Place it where `path` is documented so an author meets both together.

- [ ] **Step 2: ROADMAP — update the Stage E bullet and the limitations**

Amend the "Conditional paths and enum arguments" bullet to record that conditional *query parameters* now work and that endpoint selection plus enum lookup tables remain open. In *Known limitations*, replace the conditional-query-parameters entry with the two narrower gaps this leaves: an inlined default (`google-meet`), and repeating multi-value parameters needing `searchParams.append` (`gmail`).

**Do not publish the "six connectors" figure as a corpus measurement.** The design records that two pattern-matches disagreed (11 vs 7) and that it has not had a read-every-file pass. Either run that pass and publish the verified number with its method, or omit the count.

- [ ] **Step 3: CHANGELOG**

Add a Features entry for `query`. Add a **Breaking (spec validation)** entry for the two newly reserved identifiers `u` and `URL`, following the section's existing voice — `u` in particular is an ordinary name a spec may already use for a fetch helper or hoisted local.

- [ ] **Step 4: Full preflight**

Run:
```
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run acceptance C:/gitrep/Nimbus
bun run wiring:conformance --nimbus-root C:/gitrep/Nimbus
bun run standalone-acceptance --registry
bun run runtime:acceptance --registry
```

Report each gate's real output. A gate that could not run is reported as not run, never as passed. `--registry` and local-checkout mode answer different questions — say which was run.

**The skip policy, stated so it is not improvised.** `diff:golden`, `acceptance` and `wiring:conformance` need the AGPL monorepo and therefore **cannot run in CI at all** — they are local pre-merge gates by design. If `C:/gitrep/Nimbus` is missing or unreadable, this task is **BLOCKED**, not complete: stop and report, because the byte-safety invariant is unverifiable without them and this change touches the emitter.

Do **not** resolve a missing checkout by adding a CI job that skips when the root is absent. `CLAUDE.md` records that a silently-skipping gate is the exact failure mode this repository keeps removing.

For `standalone-acceptance --registry` and `runtime:acceptance --registry`, a network failure is likewise reported as not run. A fixture whose declared SDK floor is unpublished reports `SKIP`, and a skipped run deliberately omits the sentence a fully-verified run prints — quote the final line rather than characterising it.

- [ ] **Step 5: Commit**

```bash
git add docs/ROADMAP.md README.md CHANGELOG.md
git commit -m "docs: record conditional query parameters and the gaps that remain"
```

---

## Self-Review

**Spec coverage.** Every design section maps to a task: the `query` spec language and all four rejections → Task 1; `u`/`URL` reservation → Task 2; the absolute-URL requirement, `baseExpr` reuse and the encoding note → Tasks 3 and 4; the rendering table → Task 4; `discord` → Task 5; `google-meet` and the inline-default gap → Task 6; the ROADMAP/README/CHANGELOG updates and the gate table → Task 7. The design's *Considered and declined* section needs no task. The multi-value out-of-scope statement is carried into Task 7's limitations update.

**Type consistency.** `QueryParam = { name; arg; omitWhen? }` is defined in Task 1 and consumed under that exact name in Tasks 3 and 4. `renderQueryLines(query, ctx)` and `queryArgsUsed(query, hoisted)` are defined in Task 3 with the signatures Task 4 calls. `renderPath`'s `prefix` is added in Task 3 and used in Task 4. `baseExpr` is exported in Task 4 Step 3 before its first use in Step 4.

**Two suggestions from review, declined with precedent rather than preference.**

`QueryParamSchema.arg` stays `z.string().min(1)` rather than `identifierField()`. `arg` is a *reference* to a declared argument, not a declaration, and the repo's precedent for exactly that is `body`'s key check at `src/spec.ts:243-250` — a `superRefine` testing `k in t.args`, with no identifier schema. Adding one would fire first and report "must be a valid JS identifier" where the actionable message is "names arg X, which the tool does not declare"; a non-identifier `arg` cannot name a declared argument anyway, since argument keys are identifier-validated at `src/spec.ts:198`.

The `superRefine` reads `t.args` directly rather than guarding `!t.args ||`. `args` carries `.default({})`, so it is an object by the time any refinement runs, and `body`'s refinement three lines above does the same unguarded `k in t.args`. A guard here would be unreachable code, which this project declines on the same grounds recorded in ROADMAP's *Considered and declined* for coercing a row set whose guard already exists one level down.

**Two risks flagged rather than hidden.**

The hand-rolled branch declares a `const path`, which would need a `RESERVED_IDENTIFIERS` entry under the rule that a new handler-scope name joins the list in the same change. It does not: `path` is already reserved at `src/validate.ts:15`, verified while writing this plan, so Task 4 states that as a fact rather than leaving a check to run.

Tasks 5 and 6 derive their `expectations.json` entries from what the harness reports rather than from what the design predicts, and both say explicitly that an unpredicted difference is a finding to report rather than a fixture to massage. If `discord`'s `src/server.ts` does not match, the honest outcome is an entry that omits it plus a written reason — not a changed expectation.
