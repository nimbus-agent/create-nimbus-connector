# Stage D Implementation Plan — `read-only-kit` style and search tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the generator a third registration style (`runReadOnlyMcpConnector`, used by 60 of the 94 Nimbus connectors) and a search tool kind, so that `mercury`, `zendesk` and `bitrise` can be byte-reproduced from spec files.

**Architecture:** Both additions are additive to existing enums. `style` gains `"read-only-kit"`, which reuses every `hand-rolled` code path and changes only the server file's prologue and epilogue. `impl` gains `"search"`, which routes a tool through a new renderer and causes a seventh file, `src/search-filter.ts`, to be emitted. Target-awareness follows the existing `GenerateTarget` seam: the monorepo target imports `../../shared/*`, the standalone target imports `@nimbus-dev/sdk/connector-kit` and inlines what the SDK cannot carry.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun run`), zod 4 for spec parsing, Biome via `@biomejs/js-api` for formatting emitted output.

## Global Constraints

- **Emitters return UNFORMATTED source.** `generate()` is pure and its output goes through `formatAll()`. Never hand-align indentation for readability — Biome reindents. Do hand-manage *line breaks* where they are semantically load-bearing, because Biome preserves some author line breaks.
- **The formatter config is `FORMATTER_CONFIG` in `src/format.ts`**: 2-space indent, 100-column line width, double quotes, trailing commas, semicolons, LF endings.
- **Byte-safety invariant.** `newrelic`, `datadog`, `grafana` and `sentry` are at 6/6 in the golden harness and must stay there. Every new code path must be gated on `style === "read-only-kit"` or `impl === "search"`, which those four specs never set. After every emitter task, run `bun run diff:golden --nimbus-root C:/gitrep/Nimbus` and confirm those four still report `6/6`.
- **SDK floor.** Standalone specs *with* a search tool emit `@nimbus-dev/sdk` `^1.12.0`. Every other spec keeps `^1.11.0`. Never raise the floor unconditionally.
- **The monorepo shared import paths**, exactly: `"../../shared/run-read-only-mcp-connector.ts"`, `"../../shared/search-filter.ts"`, `"../../shared/mcp-search-tool.ts"`. All carry the `.ts` extension.
- **The standalone kit specifier** is `"@nimbus-dev/sdk/connector-kit"`, already the `KIT` constant in `src/emit/server/index.ts:9`.
- **Import ordering is enforced by the generated package's own `bun run lint`.** Biome's `organizeImports` sorts package specifiers alphabetically within the first group; relative specifiers form a second group behind a blank line. `"@nimbus-dev/sdk/connector-kit"` sorts after `"@modelcontextprotocol/*"` and before `"zod"`.
- **Never commit on `main`.** This plan's branch is `feat/stage-d-search`.
- **Do not edit anything under `C:\gitrep\Nimbus`.** It is a separate AGPL repository, read-only for this work. Task 12 is the only cross-repo task and it targets `C:\gitrep\nimbus-sdk`.

---

## File Structure

**Created:**

| Path | Responsibility |
| --- | --- |
| `src/emit/search-filter.ts` | Emits the seventh file, `src/search-filter.ts`. Owns both the `fieldsFromKeys` form and the throwing-stub form, and the monorepo/standalone import split. |
| `src/emit/server/search.ts` | Renders one `impl: "search"` tool registration into the server file. Owns the schema choice (`searchToolInputSchema(n)` vs inline `z.object`) and the `rows` envelope pluck. |
| `test/emit/search-filter.test.ts` | Unit tests for the filter-file emitter. |
| `test/emit/server/search.test.ts` | Unit tests for the search tool renderer. |
| `fixtures/mercury.spec.json`, `fixtures/zendesk.spec.json`, `fixtures/bitrise.spec.json` | Golden inputs targeting 7/7 byte reproduction. |
| `fixtures/zzsearch.spec.json`, `fixtures/zzsearchstub.spec.json` | Synthetic fixtures for the standalone and stub paths. |

**Modified:**

| Path | Change |
| --- | --- |
| `src/spec.ts:197` | `style` enum gains `"read-only-kit"`. |
| `src/spec.ts:51-106` | `ToolSchema` gains `impl: "search"`, `rows`, `maxLimit`, `filter`; four new refinements. |
| `src/spec.ts:189-259` | `ConnectorSpecSchema` gains the rest-kit/search exclusion and the `filter.export` uniqueness check. |
| `src/emit/server/index.ts` | `read-only-kit` prologue/epilogue and its import set; routes search tools. |
| `src/emit/index.ts:37-47` | Conditionally appends the search-filter file. |
| `src/emit/package-json.ts:33-36` | Conditional SDK floor. |
| `src/emit/readme.ts` | The `runReadOnly` naming caveat. |
| `fixtures/expectations.json` | Five new fixture entries. |

---

## Task 1: Accept `style: "read-only-kit"` in the schema

**Files:**
- Modify: `src/spec.ts:197`
- Test: `test/spec.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ConnectorSpec["style"]` widens to `"rest-kit" | "hand-rolled" | "read-only-kit"`. Every later task reads this value.

- [ ] **Step 1: Write the failing test**

Append to `test/spec.test.ts`:

```ts
describe("style: read-only-kit", () => {
  it("is accepted and inherits the hand-rolled fetchHelper rule", () => {
    const spec = parseSpec({
      name: "mercury",
      displayName: "Mercury",
      description: "d.",
      serviceLabel: "Mercury",
      style: "read-only-kit",
      fetchHelper: {
        local: "mercuryGet",
        base: "https://api.mercury.com",
        inlineHeaders: { Accept: "application/json" },
      },
      tools: [],
    });
    expect(spec.style).toBe("read-only-kit");
  });

  it("rejects a read-only-kit spec declaring neither headers nor inlineHeaders", () => {
    expect(() =>
      parseSpec({
        name: "mercury",
        displayName: "Mercury",
        description: "d.",
        serviceLabel: "Mercury",
        style: "read-only-kit",
        fetchHelper: { local: "mercuryGet", base: "https://api.mercury.com" },
        tools: [],
      }),
    ).toThrow(/exactly one of fetchHelper.headers or fetchHelper.inlineHeaders/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test test/spec.test.ts -t "read-only-kit"`
Expected: FAIL. The first case reports an invalid enum value; the second passes for the wrong reason (the refinement is currently keyed to `hand-rolled` only).

- [ ] **Step 3: Widen the enum**

In `src/spec.ts:197`:

```ts
    style: z.enum(["rest-kit", "hand-rolled", "read-only-kit"]).default("rest-kit"),
```

- [ ] **Step 4: Make the hand-rolled refinements cover the new style**

`read-only-kit` inherits every `hand-rolled` rule (spec §1.2). Add this helper immediately above `ConnectorSpecSchema` in `src/spec.ts`:

```ts
/**
 * The two styles that emit their own fetch helper and env accessors. `read-only-kit`
 * differs from `hand-rolled` only in the server file's prologue and epilogue (Stage D
 * design §1.2), so every schema rule keyed to "hand-rolled" applies to it unchanged.
 */
function isHandStyle(style: string): boolean {
  return style === "hand-rolled" || style === "read-only-kit";
}
```

Then in the first refinement (`src/spec.ts:205-213`), replace `s.style !== "hand-rolled" ||` with `!isHandStyle(s.style) ||`.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `bun test test/spec.test.ts -t "read-only-kit"`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the whole suite and the golden harness**

Run: `bun test && bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: all tests pass; `newrelic`, `datadog`, `grafana`, `sentry` each report `6/6`.

- [ ] **Step 7: Commit**

```bash
git add src/spec.ts test/spec.test.ts
git commit -m "feat(spec): accept style read-only-kit"
```

---

## Task 2: Emit the `read-only-kit` server prologue and epilogue

**Files:**
- Modify: `src/emit/server/index.ts:85-123`
- Test: `test/emit/server/read-only-kit.test.ts` (create)

**Interfaces:**
- Consumes: `spec.style` from Task 1; `renderHandRolledTools(spec)` from `src/emit/server/tools-hand.ts`, unchanged.
- Produces: `emitServer(spec, target)` handles the third style. No new exports.

The emitted monorepo shape, byte-targeting `mercury`:

```ts
await runReadOnlyMcpConnector("nimbus-mercury", (reg) => {
  reg( … );
});
```

- [ ] **Step 1: Write the failing test**

Create `test/emit/server/read-only-kit.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { emitServer } from "../../../src/emit/server/index.ts";
import { parseSpec } from "../../../src/spec.ts";

function make(style: string, tools: unknown[] = []) {
  return parseSpec({
    name: "mercury",
    displayName: "Mercury",
    description: "d.",
    serviceLabel: "Mercury",
    style,
    fetchHelper: {
      local: "mercuryGet",
      base: "https://api.mercury.com",
      inlineHeaders: { Accept: "application/json" },
    },
    tools,
  });
}

const LIST = [
  { name: "mercury_list", description: "List accounts.", path: "/api/v1/accounts" },
];

describe("emitServer, style read-only-kit", () => {
  it("wraps the registrations in runReadOnlyMcpConnector and emits no manual wiring", () => {
    const out = emitServer(make("read-only-kit", LIST), "monorepo").content;
    expect(out).toContain('await runReadOnlyMcpConnector("nimbus-mercury", (reg) => {');
    expect(out).not.toContain("new McpServer(");
    expect(out).not.toContain("new StdioServerTransport()");
    expect(out).not.toContain("createZodToolRegistrar");
  });

  it("imports the helper from the shared path for the monorepo target", () => {
    const out = emitServer(make("read-only-kit", LIST), "monorepo").content;
    expect(out).toContain(
      'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
    );
  });

  it("leaves hand-rolled output untouched", () => {
    const out = emitServer(make("hand-rolled", LIST), "monorepo").content;
    expect(out).toContain("const mcp = new McpServer(");
    expect(out).toContain("await mcp.connect(transport);");
    expect(out).not.toContain("runReadOnlyMcpConnector");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test test/emit/server/read-only-kit.test.ts`
Expected: FAIL on the first two cases — the output still contains `new McpServer(`. The third case passes already and is a regression guard.

- [ ] **Step 3: Implement the prologue, epilogue and import**

In `src/emit/server/index.ts`, add near the top:

```ts
const RUN_READ_ONLY = "../../shared/run-read-only-mcp-connector.ts";

function isHandStyle(spec: ConnectorSpec): boolean {
  return spec.style === "hand-rolled" || spec.style === "read-only-kit";
}
```

Change `usesJsonResult` (line 12-14) to use it:

```ts
function usesJsonResult(spec: ConnectorSpec): boolean {
  return isHandStyle(spec) && spec.tools.some((t) => t.impl !== "stub");
}
```

In `kitImportNames` (line 36-42), the registrar primitives are only needed when this file wires the server itself. Replace the first line of its body with:

```ts
  // read-only-kit delegates construction to the shared helper, so it never names the two
  // registrar primitives. Emitting them would be an unused import under the generated
  // package's own noUnusedLocals.
  const names = spec.style === "read-only-kit" ? [] : ["createRegisterSimpleTool", "createZodToolRegistrar"];
```

and change `renderNamedImport`'s one-line special case (line 45-48) to key on the emitted list rather than a fixed count:

```ts
function renderNamedImport(names: readonly string[], from: string): string[] {
  if (names.length === 0) return [];
  if (names.length <= 2) return [`import { ${names.join(", ")} } from "${from}";`];
  return ["import {", ...names.map((n) => `  ${n},`), `} from "${from}";`];
}
```

In `imports()` (line 50-83), the monorepo branch must add the helper import and drop the two `@modelcontextprotocol` imports for this style. Replace the function body's `head` initialisation and monorepo tail with:

```ts
  const head =
    spec.style === "read-only-kit"
      ? []
      : [
          'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
          'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
        ];
```

and, in the monorepo branch after the existing `head.push("")`:

```ts
  if (spec.style === "read-only-kit") {
    const kit = kitImportNames(spec, false);
    if (kit.length > 0) head.push(...renderNamedImport(kit, "../../shared/mcp-tool-kit.ts"));
    head.push(`import { runReadOnlyMcpConnector } from "${RUN_READ_ONLY}";`);
    return head.join("\n");
  }
```

Replace `wiring` and `tail` (lines 85-98) so both return `undefined` for the new style:

```ts
function wiring(spec: ConnectorSpec): string | undefined {
  if (spec.style === "read-only-kit") return undefined;
  const v = spec.style === "hand-rolled" ? "mcp" : "server";
  return [
    `const ${v} = new McpServer({ name: "nimbus-${spec.name}", version: "0.1.0" });`,
    `const reg = createZodToolRegistrar(createRegisterSimpleTool(${v}));`,
  ].join("\n");
}

function tail(spec: ConnectorSpec): string | undefined {
  if (spec.style === "read-only-kit") return undefined;
  const v = spec.style === "hand-rolled" ? "mcp" : "server";
  return ["const transport = new StdioServerTransport();", `await ${v}.connect(transport);`].join(
    "\n",
  );
}
```

In `emitServer` (line 100-123), wrap the tool section for the new style. Replace the `sections` array's last three entries with:

```ts
    ...(wiring(spec) === undefined ? [] : [wiring(spec)!]),
    renderTools(spec),
    ...(tail(spec) === undefined ? [] : [tail(spec)!]),
```

and add above `emitServer`:

```ts
/**
 * The registrations, wrapped for read-only-kit. Indentation is deliberately NOT applied
 * here — generate() returns unformatted source and formatAll() reindents the block.
 */
function renderTools(spec: ConnectorSpec): string {
  const body = isHandStyle(spec) ? renderHandRolledTools(spec) : renderRestKitTools(spec);
  if (spec.style !== "read-only-kit") return body;
  return [
    `await runReadOnlyMcpConnector("nimbus-${spec.name}", (reg) => {`,
    body,
    "});",
  ].join("\n");
}
```

Finally, change `const isHand = spec.style === "hand-rolled";` (line 101) to `const isHand = isHandStyle(spec);` so the env accessors and fetch helpers are emitted for the new style too.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test test/emit/server/read-only-kit.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Confirm the emitted source is valid TypeScript**

Run: `bun test test/emit/emitted-typecheck.test.ts`
Expected: PASS. This is the check that catches an unbalanced brace in `renderTools`, which unit assertions on substrings cannot see.

- [ ] **Step 6: Run the whole suite and the golden harness**

Run: `bun test && bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: all pass; the four read fixtures still report `6/6`.

- [ ] **Step 7: Commit**

```bash
git add src/emit/server/index.ts test/emit/server/read-only-kit.test.ts
git commit -m "feat(emit): emit the read-only-kit server prologue and epilogue"
```

---

## Task 3: Emit the standalone `read-only-kit` glue inline

**Files:**
- Modify: `src/emit/server/index.ts`
- Test: `test/emit/server/read-only-kit.test.ts`

**Interfaces:**
- Consumes: Task 2's `renderTools` and `imports`.
- Produces: the standalone target emits a local `runReadOnlyMcpConnector` definition, so the call site in `renderTools` is identical across targets.

**Already verified — do not re-derive.** Both types the glue's signature names, `McpListResult` and `ZodObjectSchema`, are already exported from `sdks/typescript/src/connector-kit/index.ts` (`export type { HttpJsonBodyResponse, HttpTextResponse, McpListResult, RegisterSimpleToolFn, ZodObjectSchema } from "./mcp-tool-kit.js";`). Task 12 does not need to add them.

- [ ] **Step 1: Write the failing test**

Append to `test/emit/server/read-only-kit.test.ts`:

```ts
describe("emitServer, style read-only-kit, standalone target", () => {
  it("defines the helper locally instead of importing it", () => {
    const out = emitServer(make("read-only-kit", LIST), "standalone").content;
    expect(out).not.toContain("../../shared/");
    expect(out).toContain("async function runReadOnlyMcpConnector(");
    expect(out).toContain(
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    );
    expect(out).toContain(
      'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
    );
  });

  it("uses the identical call site on both targets", () => {
    const call = 'await runReadOnlyMcpConnector("nimbus-mercury", (reg) => {';
    expect(emitServer(make("read-only-kit", LIST), "monorepo").content).toContain(call);
    expect(emitServer(make("read-only-kit", LIST), "standalone").content).toContain(call);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test test/emit/server/read-only-kit.test.ts -t "standalone"`
Expected: FAIL — no local definition is emitted.

- [ ] **Step 3: Implement the inline glue**

Add to `src/emit/server/index.ts`:

```ts
/**
 * The standalone equivalent of shared/run-read-only-mcp-connector.ts, emitted into the
 * package rather than added to the SDK: the SDK core must not depend on
 * @modelcontextprotocol/sdk, and the generated package already does. The two registrar
 * primitives it builds on ARE SDK exports, so only this glue is local.
 */
function renderRunReadOnlyGlue(): string {
  return [
    "type ZodToolRegistrar = <T>(",
    "  name: string,",
    "  description: string,",
    "  schema: ZodObjectSchema<T>,",
    "  handler: (args: T) => Promise<McpListResult>,",
    ") => void;",
    "",
    "async function runReadOnlyMcpConnector(",
    "  serverName: string,",
    "  register: (reg: ZodToolRegistrar) => void,",
    "): Promise<void> {",
    '  const mcp = new McpServer({ name: serverName, version: "0.1.0" });',
    "  register(createZodToolRegistrar(createRegisterSimpleTool(mcp)));",
    "  const transport = new StdioServerTransport();",
    "  await mcp.connect(transport);",
    "}",
  ].join("\n");
}
```

The glue names two SDK types. In `kitImportNames`, the standalone `read-only-kit` branch needs the registrar primitives back, plus those types. Replace the first line of `kitImportNames`'s body with:

```ts
  // Monorepo read-only-kit delegates to the shared helper and names neither primitive;
  // standalone emits the glue itself, so it needs both, plus the two types the glue's
  // signature references.
  const names =
    spec.style === "read-only-kit" && target === "monorepo"
      ? []
      : ["createRegisterSimpleTool", "createZodToolRegistrar"];
  if (spec.style === "read-only-kit" && target === "standalone") {
    names.push("type McpListResult", "type ZodObjectSchema");
  }
```

and add `target: GenerateTarget` as `kitImportNames`'s third parameter, updating both call sites (`imports()` passes its own `target`; the monorepo hand-rolled call passes `"monorepo"`).

Insert the glue into `emitServer`'s `sections`, immediately before `renderTools(spec)`:

```ts
    ...(spec.style === "read-only-kit" && target === "standalone"
      ? [renderRunReadOnlyGlue()]
      : []),
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test test/emit/server/read-only-kit.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the whole suite and the golden harness**

Run: `bun test && bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: all pass; four fixtures at `6/6`.

- [ ] **Step 6: Commit**

```bash
git add src/emit/server/index.ts test/emit/server/read-only-kit.test.ts
git commit -m "feat(emit): inline the runReadOnly glue for the standalone target"
```

---

## Task 4: Add the search tool fields to the schema

**Files:**
- Modify: `src/spec.ts:51-106`
- Test: `test/spec.test.ts`

**Interfaces:**
- Consumes: Task 1's widened `style`.
- Produces: `ToolSpec` gains `impl: "search"`, `rows?: string`, `maxLimit: number` (default 100), and `filter?: { export: string; fields?: string[]; tags: boolean }`. Tasks 5-8 read all four.

- [ ] **Step 1: Write the failing test**

Append to `test/spec.test.ts`:

```ts
describe("impl: search", () => {
  function tool(extra: Record<string, unknown> = {}) {
    return {
      name: "mercury_search",
      description: "Search accounts.",
      impl: "search",
      path: "/api/v1/accounts",
      filter: { export: "filterMercuryAccounts", fields: ["id", "name"] },
      ...extra,
    };
  }
  function make(t: unknown, style = "read-only-kit") {
    return parseSpec({
      name: "mercury",
      displayName: "Mercury",
      description: "d.",
      serviceLabel: "Mercury",
      style,
      fetchHelper: {
        local: "mercuryGet",
        base: "https://api.mercury.com",
        inlineHeaders: { Accept: "application/json" },
      },
      tools: [t],
    });
  }

  it("defaults maxLimit to 100 and tags to false", () => {
    const t = make(tool()).tools[0]!;
    expect(t.maxLimit).toBe(100);
    expect(t.filter?.tags).toBe(false);
  });

  it("accepts rows and a custom maxLimit", () => {
    const t = make(tool({ rows: "accounts", maxLimit: 2000 })).tools[0]!;
    expect(t.rows).toBe("accounts");
    expect(t.maxLimit).toBe(2000);
  });

  it("requires a filter", () => {
    expect(() => make({ ...tool(), filter: undefined })).toThrow(/"filter" is required/);
  });

  it("rejects an empty fields list", () => {
    expect(() => make(tool({ filter: { export: "f", fields: [] } }))).toThrow(
      /at least one field/,
    );
  });

  it("rejects method and body", () => {
    expect(() => make(tool({ method: "POST" }))).toThrow(/issues a GET/);
    expect(() => make(tool({ body: { a: "b" } }))).toThrow(/issues a GET/);
  });

  it("rejects a non-read effect", () => {
    expect(() => make(tool({ effect: "write" }))).toThrow(/cannot mutate/);
  });

  it("rejects a non-identifier filter.export", () => {
    expect(() => make(tool({ filter: { export: "not a name", fields: ["id"] } }))).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test test/spec.test.ts -t "impl: search"`
Expected: FAIL — `impl` rejects `"search"` as an invalid enum value.

- [ ] **Step 3: Implement the schema fields**

Add above `ToolSchema` in `src/spec.ts`:

```ts
/**
 * The per-connector search filter. `fields` omitted means the emitter cannot express the
 * extraction and emits a throwing stub instead (Stage D design D5) — 40 of the 49 corpus
 * filter files hand-write an extractor this shape cannot reach.
 */
export const SearchFilterSchema = z.strictObject({
  export: identifierField(),
  fields: z.array(z.string().min(1)).min(1, "a filter must name at least one field").optional(),
  tags: z.boolean().default(false),
});
```

In `ToolSchema`'s `strictObject` (line 52), extend the `impl` enum and add three fields:

```ts
    impl: z
      .enum(["rest", "get", "stub", "search"])
      .default("rest")
      .transform((v) => (v === "get" ? "rest" : v)),
```

```ts
    /** Property plucked from the response envelope. Omitted means the response IS the array. */
    rows: z.string().min(1).optional(),
    /** Per-connector result cap. Corpus: 100 ×24, 200 ×12, 2000 ×2, 50 ×1. */
    maxLimit: z.number().int().positive().default(100),
    filter: SearchFilterSchema.optional(),
```

Then append four refinements to `ToolSchema`, after the existing `superRefine`:

```ts
  .refine((t) => (t.impl === "search") === (t.filter !== undefined), {
    message:
      '"filter" is required when "impl" is "search", and is not valid on any other tool kind',
  })
  .refine((t) => !(t.impl === "search" && (t.method !== "GET" || t.body !== undefined)), {
    message: 'a "search" tool issues a GET, so "method" and "body" have nothing to describe',
  })
  .refine((t) => !(t.impl === "search" && t.effect !== "read"), {
    message:
      'a "search" tool cannot mutate — "effect" must be "read". Unlike a stub, it stands in ' +
      "for nothing that will later write.",
  })
  .refine((t) => t.impl === "search" || (t.rows === undefined && t.maxLimit === 100), {
    message: '"rows" and "maxLimit" are only valid on a tool with "impl": "search"',
  });
```

The existing `impl`/`path` refinement at line 80 already requires a `path` for `"search"`, because it only exempts `"stub"`. No change there.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test test/spec.test.ts -t "impl: search"`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the whole suite**

Run: `bun test`
Expected: all pass. The `maxLimit === 100` clause in the last refinement is checked *after* defaulting, so a non-search tool that never mentions `maxLimit` satisfies it.

- [ ] **Step 6: Commit**

```bash
git add src/spec.ts test/spec.test.ts
git commit -m "feat(spec): add the impl search tool fields"
```

---

## Task 5: Reject search on `rest-kit`, and duplicate `filter.export`

**Files:**
- Modify: `src/spec.ts:189-259`
- Test: `test/spec.test.ts`

**Interfaces:**
- Consumes: Task 4's `filter` and `impl: "search"`.
- Produces: no new types. Two spec-level refinements.

- [ ] **Step 1: Write the failing test**

Append to `test/spec.test.ts`:

```ts
describe("search and style interaction", () => {
  const searchTool = {
    name: "s_search",
    description: "Search.",
    impl: "search",
    path: "/items",
    filter: { export: "filterItems", fields: ["id"] },
  };

  it("rejects a search tool on style rest-kit", () => {
    expect(() =>
      parseSpec({
        name: "s",
        displayName: "S",
        description: "d.",
        serviceLabel: "S",
        style: "rest-kit",
        env: [{ vars: ["S_TOKEN"], local: "token", auth: "bearer" }],
        fetchHelper: { local: "sGet", base: "https://api.s.com" },
        tools: [searchTool],
      }),
    ).toThrow(/no seam/);
  });

  it("rejects two tools sharing one filter.export", () => {
    expect(() =>
      parseSpec({
        name: "s",
        displayName: "S",
        description: "d.",
        serviceLabel: "S",
        style: "read-only-kit",
        fetchHelper: {
          local: "sGet",
          base: "https://api.s.com",
          inlineHeaders: { Accept: "application/json" },
        },
        tools: [searchTool, { ...searchTool, name: "s_search_two", path: "/others" }],
      }),
    ).toThrow(/filterItems/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test test/spec.test.ts -t "search and style interaction"`
Expected: FAIL — both specs currently parse.

- [ ] **Step 3: Implement both refinements**

Append to `ConnectorSpecSchema` in `src/spec.ts`:

```ts
  // Measured: the intersection of the 10 rest-tool-kit users and the 45 mcp-search-tool
  // users in the corpus is empty, and the code explains why — makeRestToolRegistrar
  // performs the fetch AND wraps the result, so there is no callback between the response
  // and the MCP result for the filter to run in. Same shape as the client-credentials
  // exclusion above.
  .refine((s) => s.style !== "rest-kit" || !s.tools.some((t) => t.impl === "search"), {
    message:
      'style "rest-kit" cannot declare an "impl": "search" tool: makeRestToolRegistrar ' +
      "performs the request and wraps the result itself, so it has no seam for the filter. " +
      'Use style "read-only-kit" or "hand-rolled".',
  })
  // One emitted `export const` per filter, all in one src/search-filter.ts. Two tools
  // naming the same export would emit a duplicate declaration. No corpus connector reuses
  // one filter across two search tools (raindrop's two are distinct exports).
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    for (const t of s.tools) {
      const name = t.filter?.export;
      if (name === undefined) continue;
      if (seen.has(name)) {
        ctx.addIssue({
          code: "custom",
          message:
            `two tools declare "filter.export": "${name}" — each search tool emits its own ` +
            "export into src/search-filter.ts, so the names must differ",
        });
      }
      seen.add(name);
    }
  });
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test test/spec.test.ts -t "search and style interaction"`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the whole suite**

Run: `bun test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/spec.ts test/spec.test.ts
git commit -m "feat(spec): reject search on rest-kit and duplicate filter exports"
```

---

## Task 6: Render the search tool registration

**Files:**
- Create: `src/emit/server/search.ts`
- Modify: `src/emit/server/args.ts:28-33` (Step 3a)
- Modify: `src/emit/server/tools-hand.ts:8-30`
- Test: `test/emit/server/search.test.ts` (create)

**Interfaces:**
- Consumes: `ToolSpec` from Task 4; `renderZodFields(tool.args)` from `src/emit/server/args.ts` (extracted in Step 3a below); `parsePathTemplate` / `renderPath` from `src/emit/server/path-template.ts`.
- Produces: `renderSearchTool(spec: ConnectorSpec, tool: ToolSpec): string`, called by `renderTool` in `tools-hand.ts`. Also `renderZodFields(args: Args): string` from `args.ts`, which nothing else consumes yet.

Target output for `mercury` (no args, `rows: "accounts"`):

```ts
reg(
  "mercury_search",
  "Substring search across the user's Mercury accounts.",
  searchToolInputSchema(100),
  async (p) => {
    const root = await mercuryGet(`/api/v1/accounts`);
    const accounts = (root as { accounts?: unknown[] } | null)?.accounts;
    return matchesResult(accounts, filterMercuryAccounts, p);
  },
);
```

Target output for `bitrise` (args present, no `rows`) uses an inline schema and passes the response straight through.

- [ ] **Step 1: Write the failing test**

Create `test/emit/server/search.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { renderSearchTool } from "../../../src/emit/server/search.ts";
import { parseSpec } from "../../../src/spec.ts";

function make(tool: Record<string, unknown>) {
  const spec = parseSpec({
    name: "mercury",
    displayName: "Mercury",
    description: "d.",
    serviceLabel: "Mercury",
    style: "read-only-kit",
    fetchHelper: {
      local: "mercuryGet",
      base: "https://api.mercury.com",
      inlineHeaders: { Accept: "application/json" },
    },
    tools: [tool],
  });
  return renderSearchTool(spec, spec.tools[0]!);
}

describe("renderSearchTool", () => {
  it("uses searchToolInputSchema and plucks the envelope when rows is set", () => {
    const out = make({
      name: "mercury_search",
      description: "Search accounts.",
      impl: "search",
      path: "/api/v1/accounts",
      rows: "accounts",
      filter: { export: "filterMercuryAccounts", fields: ["id"] },
    });
    expect(out).toContain("searchToolInputSchema(100)");
    expect(out).toContain("const root = await mercuryGet(`/api/v1/accounts`);");
    expect(out).toContain(
      "const accounts = (root as { accounts?: unknown[] } | null)?.accounts;",
    );
    expect(out).toContain("return matchesResult(accounts, filterMercuryAccounts, p);");
  });

  it("passes the response straight through when rows is omitted", () => {
    const out = make({
      name: "mercury_search",
      description: "Search accounts.",
      impl: "search",
      path: "/api/v1/accounts",
      filter: { export: "filterMercuryAccounts", fields: ["id"] },
    });
    expect(out).not.toContain("const root =");
    expect(out).toContain(
      "return matchesResult(await mercuryGet(`/api/v1/accounts`), filterMercuryAccounts, p);",
    );
  });

  it("honours a custom maxLimit", () => {
    const out = make({
      name: "mercury_search",
      description: "Search accounts.",
      impl: "search",
      path: "/api/v1/accounts",
      maxLimit: 2000,
      filter: { export: "filterMercuryAccounts", fields: ["id"] },
    });
    expect(out).toContain("searchToolInputSchema(2000)");
  });

  it("inlines the schema when the tool declares its own args", () => {
    const out = make({
      name: "bitrise_build_search",
      description: "Search builds.",
      impl: "search",
      args: { appSlug: { type: "string", min: 1 } },
      path: "/v0.1/apps/${arg.appSlug}/builds",
      filter: { export: "filterBitriseBuilds", fields: ["branch"] },
    });
    expect(out).not.toContain("searchToolInputSchema");
    expect(out).toContain("appSlug: z.string().min(1)");
    expect(out).toContain("query: z.string().min(1)");
    expect(out).toContain("limit: z.number().int().min(1).max(100).optional()");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test test/emit/server/search.test.ts`
Expected: FAIL — `src/emit/server/search.ts` does not exist.

- [ ] **Step 3a: Extract the field renderer from `renderZodSchema`**

The inline-schema case needs the *fields* of a `z.object({ … })`, not the wrapper. Taking them by stripping the wrapper back off with a regex would couple this module to another module's output formatting, so expose the inner renderer instead.

In `src/emit/server/args.ts`, split the existing `renderZodSchema` (lines 28-33) into two:

```ts
/** The comma-joined field list of a zod object, with no wrapper. Always one line. */
export function renderZodFields(args: Args): string {
  return Object.entries(args)
    .map(([name, a]) => `${name}: ${renderOne(a)}`)
    .join(", ");
}

export function renderZodSchema(args: Args): string {
  const fields = renderZodFields(args);
  return fields === "" ? "z.object({})" : `z.object({ ${fields} })`;
}
```

This is a pure refactor: `renderZodSchema`'s output is unchanged for every input, including the empty case.

Run: `bun test test/emit/server/args.test.ts && bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: PASS, and the four read fixtures still `6/6` — proof the refactor moved no bytes.

- [ ] **Step 3: Implement the renderer**

Create `src/emit/server/search.ts`:

```ts
import type { ConnectorSpec, ToolSpec } from "../../spec.ts";
import { renderZodFields } from "./args.ts";
import { parsePathTemplate, renderPath } from "./path-template.ts";

const PARAM = "p";

/**
 * The search input schema. A tool with no arguments of its own calls the shared
 * searchToolInputSchema(maxLimit) — the form 44 corpus connectors use, and the one the
 * byte-diff fixtures require. A tool that declares args cannot: the shared helper builds a
 * fixed two-key object, so bitrise inlines the merged shape instead.
 */
function renderSchema(tool: ToolSpec): string {
  if (Object.keys(tool.args).length === 0) return `searchToolInputSchema(${tool.maxLimit})`;
  const own = renderZodFields(tool.args);
  return (
    `z.object({ ${own}, query: z.string().min(1), ` +
    `limit: z.number().int().min(1).max(${tool.maxLimit}).optional() })`
  );
}

export function renderSearchTool(spec: ConnectorSpec, tool: ToolSpec): string {
  // Schema guarantees both: ToolSchema requires a path for any non-stub tool, and requires
  // a filter for every search tool.
  const filterExport = tool.filter!.export;
  const pathExpr = renderPath(parsePathTemplate(tool.path!), { param: PARAM, hoisted: new Map() });
  const fetchCall = `await ${spec.fetchHelper.local}(${pathExpr})`;

  const head = [
    "reg(",
    `  ${JSON.stringify(tool.name)},`,
    `  ${JSON.stringify(tool.description)},`,
    `  ${renderSchema(tool)},`,
    `  async (${PARAM}) => {`,
  ];

  // Without `rows` the response IS the array and needs no local — matchesResult takes
  // `unknown` and guards with Array.isArray itself, so no coercion is emitted either.
  if (tool.rows === undefined) {
    return [
      ...head,
      `    return matchesResult(${fetchCall}, ${filterExport}, ${PARAM});`,
      "  },",
      ");",
    ].join("\n");
  }

  const rows = tool.rows;
  return [
    ...head,
    `    const root = ${fetchCall};`,
    `    const ${rows} = (root as { ${rows}?: unknown[] } | null)?.${rows};`,
    `    return matchesResult(${rows}, ${filterExport}, ${PARAM});`,
    "  },",
    ");",
  ].join("\n");
}
```

- [ ] **Step 4: Route search tools from the hand-rolled renderer**

In `src/emit/server/tools-hand.ts`, add the import:

```ts
import { renderSearchTool } from "./search.ts";
```

and insert at the top of `renderTool`'s body, before the `const schema = …` line:

```ts
  if (tool.impl === "search") return renderSearchTool(spec, tool);
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `bun test test/emit/server/search.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Run the whole suite and the golden harness**

Run: `bun test && bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: all pass; four fixtures at `6/6`.

- [ ] **Step 7: Commit**

```bash
git add src/emit/server/search.ts src/emit/server/tools-hand.ts test/emit/server/search.test.ts
git commit -m "feat(emit): render impl search tool registrations"
```

---

## Task 7: Add the search imports to the server file

**Files:**
- Modify: `src/emit/server/index.ts`
- Test: `test/emit/server/search.test.ts`

**Interfaces:**
- Consumes: Task 6's renderer.
- Produces: the server file imports `matchesResult` / `searchToolInputSchema` and the filter exports.

Monorepo imports for `mercury`, in Biome's order:

```ts
import { z } from "zod";
import { matchesResult, searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterMercuryAccounts } from "./search-filter.ts";
```

- [ ] **Step 1: Write the failing test**

Append to `test/emit/server/search.test.ts`:

```ts
import { emitServer } from "../../../src/emit/server/index.ts";

function specWith(tools: unknown[], style = "read-only-kit") {
  return parseSpec({
    name: "mercury",
    displayName: "Mercury",
    description: "d.",
    serviceLabel: "Mercury",
    style,
    fetchHelper: {
      local: "mercuryGet",
      base: "https://api.mercury.com",
      inlineHeaders: { Accept: "application/json" },
    },
    tools,
  });
}

const SEARCH = {
  name: "mercury_search",
  description: "Search accounts.",
  impl: "search",
  path: "/api/v1/accounts",
  rows: "accounts",
  filter: { export: "filterMercuryAccounts", fields: ["id"] },
};

describe("emitServer search imports", () => {
  it("imports both search helpers and the filter, monorepo", () => {
    const out = emitServer(specWith([SEARCH]), "monorepo").content;
    expect(out).toContain(
      'import { matchesResult, searchToolInputSchema } from "../../shared/mcp-search-tool.ts";',
    );
    expect(out).toContain('import { filterMercuryAccounts } from "./search-filter.ts";');
  });

  it("omits searchToolInputSchema when every search tool inlines its schema", () => {
    const out = emitServer(
      specWith([{ ...SEARCH, args: { appSlug: { type: "string", min: 1 } }, path: "/a/${arg.appSlug}/b" }]),
      "monorepo",
    ).content;
    expect(out).toContain('import { matchesResult } from "../../shared/mcp-search-tool.ts";');
    expect(out).not.toContain("searchToolInputSchema");
  });

  it("imports both from the SDK kit on standalone", () => {
    const out = emitServer(specWith([SEARCH]), "standalone").content;
    expect(out).not.toContain("../../shared/");
    expect(out).toContain('import { filterMercuryAccounts } from "./search-filter.ts";');
    expect(out).toContain("matchesResult");
  });

  it("emits no search imports for a spec with no search tool", () => {
    const out = emitServer(
      specWith([{ name: "mercury_list", description: "List.", path: "/api/v1/accounts" }]),
      "monorepo",
    ).content;
    expect(out).not.toContain("mcp-search-tool");
    expect(out).not.toContain("search-filter");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test test/emit/server/search.test.ts -t "search imports"`
Expected: FAIL — no search imports are emitted.

- [ ] **Step 3: Implement the imports**

Add to `src/emit/server/index.ts`:

```ts
const SEARCH_TOOL = "../../shared/mcp-search-tool.ts";

function searchTools(spec: ConnectorSpec): ToolSpec[] {
  return spec.tools.filter((t) => t.impl === "search");
}

/**
 * matchesResult is always needed by a search connector; searchToolInputSchema only by a
 * search tool that declares no args of its own — bitrise inlines its schema and never
 * calls the helper, so importing it unconditionally would be an unused import under the
 * generated package's own noUnusedLocals.
 */
function searchKitNames(spec: ConnectorSpec): string[] {
  const tools = searchTools(spec);
  if (tools.length === 0) return [];
  const names = ["matchesResult"];
  if (tools.some((t) => Object.keys(t.args).length === 0)) names.push("searchToolInputSchema");
  return names;
}

/** One import line naming every filter this server calls, in declaration order. */
function filterImport(spec: ConnectorSpec): string | undefined {
  const exports = searchTools(spec).map((t) => t.filter!.export);
  if (exports.length === 0) return undefined;
  return `import { ${exports.join(", ")} } from "./search-filter.ts";`;
}
```

Import `ToolSpec` alongside `ConnectorSpec` at the top of the file.

In `imports()`, the standalone branch already emits one kit import; add the search names to it by changing the `kitImportNames(spec, true)` call to merge in `searchKitNames(spec)` — the merged list must stay alphabetically sorted, so sort the combined array before rendering. In the monorepo branch, append after the `runReadOnlyMcpConnector` line (and equivalently in the hand-rolled branch):

```ts
  const search = searchKitNames(spec);
  if (search.length > 0) head.push(...renderNamedImport(search, SEARCH_TOOL));
```

Then, in both branches, append the filter import last — `"./search-filter.ts"` is a relative specifier and sorts after every `../../shared/*` entry:

```ts
  const filters = filterImport(spec);
  if (filters !== undefined) head.push(filters);
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test test/emit/server/search.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the whole suite and the golden harness**

Run: `bun test && bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: all pass; four fixtures at `6/6`.

- [ ] **Step 6: Commit**

```bash
git add src/emit/server/index.ts test/emit/server/search.test.ts
git commit -m "feat(emit): import the search helpers and filter exports"
```

---

## Task 8: Emit `src/search-filter.ts`

**Files:**
- Create: `src/emit/search-filter.ts`
- Modify: `src/emit/index.ts:37-47`
- Test: `test/emit/search-filter.test.ts` (create)

**Interfaces:**
- Consumes: `ConnectorSpec`, `GenerateTarget`.
- Produces: `emitSearchFilter(spec: ConnectorSpec, target: GenerateTarget): GeneratedFile | undefined`, appended to `generate()`'s file list when defined.

Target output for `mercury`, byte-matching the corpus:

```ts
import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type MercurySearchMatchOptions = SearchMatchOptions;

export const filterMercuryAccounts = makeQueryFilter(
  fieldsFromKeys(["id", "name", "status", "type", "kind", "legalBusinessName"]),
);
```

- [ ] **Step 1: Write the failing test**

Create `test/emit/search-filter.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { emitSearchFilter } from "../../src/emit/search-filter.ts";
import { parseSpec } from "../../src/spec.ts";

function make(tools: unknown[]) {
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
      inlineHeaders: { Accept: "application/json" },
    },
    tools,
  });
}

const KEYED = {
  name: "mercury_search",
  description: "Search.",
  impl: "search",
  path: "/api/v1/accounts",
  filter: { export: "filterMercuryAccounts", fields: ["id", "name"] },
};

describe("emitSearchFilter", () => {
  it("returns undefined for a spec with no search tool", () => {
    expect(
      emitSearchFilter(
        make([{ name: "mercury_list", description: "List.", path: "/api/v1/accounts" }]),
        "monorepo",
      ),
    ).toBeUndefined();
  });

  it("emits the fieldsFromKeys shape at src/search-filter.ts", () => {
    const file = emitSearchFilter(make([KEYED]), "monorepo")!;
    expect(file.path).toEqual(["src", "search-filter.ts"]);
    expect(file.content).toContain('} from "../../shared/search-filter.ts";');
    expect(file.content).toContain("export type MercurySearchMatchOptions = SearchMatchOptions;");
    expect(file.content).toContain(
      'export const filterMercuryAccounts = makeQueryFilter(\n  fieldsFromKeys(["id", "name"]),\n);',
    );
  });

  it("passes { tags: true } through", () => {
    const file = emitSearchFilter(
      make([{ ...KEYED, filter: { export: "f", fields: ["id"], tags: true } }]),
      "monorepo",
    )!;
    expect(file.content).toContain('fieldsFromKeys(["id"], { tags: true })');
  });

  it("emits a throwing filter, not a throwing extractor, when fields is omitted", () => {
    const file = emitSearchFilter(
      make([{ ...KEYED, filter: { export: "filterMercuryAccounts" } }]),
      "monorepo",
    )!;
    expect(file.content).not.toContain("makeQueryFilter");
    expect(file.content).not.toContain("fieldsFromKeys");
    expect(file.content).toContain("export const filterMercuryAccounts: SearchFilter = () => {");
    expect(file.content).toContain("throw new Error(");
  });

  it("imports the kit for the standalone target", () => {
    const file = emitSearchFilter(make([KEYED]), "standalone")!;
    expect(file.content).toContain('} from "@nimbus-dev/sdk/connector-kit";');
    expect(file.content).not.toContain("../../shared/");
  });

  it("emits one export per search tool", () => {
    const file = emitSearchFilter(
      make([
        KEYED,
        { ...KEYED, name: "mercury_search_two", path: "/api/v1/cards", filter: { export: "filterMercuryCards", fields: ["id"] } },
      ]),
      "monorepo",
    )!;
    expect(file.content).toContain("export const filterMercuryAccounts");
    expect(file.content).toContain("export const filterMercuryCards");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test test/emit/search-filter.test.ts`
Expected: FAIL — `src/emit/search-filter.ts` does not exist.

- [ ] **Step 3: Implement the emitter**

Create `src/emit/search-filter.ts`:

```ts
import type { ConnectorSpec, ToolSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";
import type { GenerateTarget } from "./index.ts";

const SHARED = "../../shared/search-filter.ts";
const SEARCH_TOOL = "../../shared/mcp-search-tool.ts";
const KIT = "@nimbus-dev/sdk/connector-kit";

/** Sort key ignoring the `type ` prefix, which Biome does not consider when ordering. */
function byBareName(a: string, b: string): number {
  return a.replace("type ", "").localeCompare(b.replace("type ", ""));
}

/** A single-name import stays on one line; two or more use the wrapped block form. */
function renderBlockImport(names: readonly string[], from: string): string {
  if (names.length === 1) return `import { ${names[0]} } from "${from}";`;
  return ["import {", ...names.map((n) => `  ${n},`), `} from "${from}";`].join("\n");
}

function keyedFilter(tool: ToolSpec): string {
  const keys = JSON.stringify(tool.filter!.fields);
  const opts = tool.filter!.tags ? ", { tags: true }" : "";
  return [
    `export const ${tool.filter!.export} = makeQueryFilter(`,
    `  fieldsFromKeys(${keys}${opts}),`,
    ");",
  ].join("\n");
}

/**
 * The stub replaces the FILTER, not the extractor, and that is load-bearing rather than
 * stylistic. makeQueryFilter returns a closure that defers to filterByQuery, which calls
 * options.fields(item) once per row — so a throwing extractor never fires on an empty
 * result set and the tool reports `{ matches: [] }` as success. Throwing from the filter
 * position fires on every invocation. See Stage D design §4.3.1.
 */
function stubFilter(tool: ToolSpec): string {
  const message = JSON.stringify(
    `${tool.name}: supply the searchable fields for this resource — replace this stub ` +
      "with makeQueryFilter(fieldsFromKeys([...])) or a bespoke extractor.",
  );
  return [
    `export const ${tool.filter!.export}: SearchFilter = () => {`,
    `  throw new Error(${message});`,
    "};",
  ].join("\n");
}

export function emitSearchFilter(
  spec: ConnectorSpec,
  target: GenerateTarget,
): GeneratedFile | undefined {
  const tools = spec.tools.filter((t) => t.impl === "search");
  if (tools.length === 0) return undefined;

  const anyKeyed = tools.some((t) => t.filter!.fields !== undefined);
  const anyStub = tools.some((t) => t.filter!.fields === undefined);

  // Only the symbols something in this file actually names — an unused import is a
  // noUnusedLocals error in the generated package, and biome's own lint rejects it too.
  const filterNames: string[] = [];
  if (anyKeyed) filterNames.push("fieldsFromKeys", "makeQueryFilter");
  filterNames.push("type SearchMatchOptions");
  filterNames.sort((a, b) => a.replace("type ", "").localeCompare(b.replace("type ", "")));

  const importLines =
    target === "standalone"
      ? // One barrel, so one import: the SDK's connector-kit re-exports SearchFilter
        // alongside the rest (Task 12).
        [renderBlockImport([...filterNames, "type SearchFilter"].sort(byBareName), KIT)]
      : // Two modules in the monorepo, and the split is not cosmetic: SearchFilter is
        // declared in shared/mcp-search-tool.ts, NOT in shared/search-filter.ts. Emitting it
        // from the latter is an unresolved import that fails the connector's own tsc.
        // Both specifiers are relative, and "mcp-search-tool" sorts before "search-filter".
        [
          ...(anyStub ? [renderBlockImport(["type SearchFilter"], SEARCH_TOOL)] : []),
          renderBlockImport(filterNames, SHARED),
        ];

  const sections = [
    importLines.join("\n"),
    `export type ${spec.title}SearchMatchOptions = SearchMatchOptions;`,
    ...tools.map((t) => (t.filter!.fields === undefined ? stubFilter(t) : keyedFilter(t))),
  ];

  return { path: ["src", "search-filter.ts"], content: `${sections.join("\n\n")}\n` };
}
```

**Verified, so the code above already splits it.** `shared/search-filter.ts` exports `SearchMatchOptions`, `FilterByQueryOptions`, `FieldExtractor`, `asRecord`, `asObjectish`, `stringField`, `tagText`, `tagNamesFromObjects`, `filterByQuery`, `fieldsFromKeys`, `nestedString` and `makeQueryFilter` — and **not** `SearchFilter`, which is declared in `shared/mcp-search-tool.ts`. A monorepo stub file therefore needs two import lines; emitting `type SearchFilter` from `SHARED` would be an unresolved import that fails the connector's own `tsc`. The standalone barrel re-exports both after Task 12, so one import is correct there.

Add this case to the test file for the split, since it is the only thing that pins it:

```ts
it("imports SearchFilter from mcp-search-tool, not search-filter, on monorepo", () => {
  const file = emitSearchFilter(
    make([{ ...KEYED, filter: { export: "filterMercuryAccounts" } }]),
    "monorepo",
  )!;
  expect(file.content).toContain(
    'import { type SearchFilter } from "../../shared/mcp-search-tool.ts";',
  );
  expect(file.content).not.toMatch(/SearchFilter[\s\S]*?from "\.\.\/\.\.\/shared\/search-filter\.ts"/);
});
```

- [ ] **Step 4: Wire it into `generate()`**

In `src/emit/index.ts`, add the import:

```ts
import { emitSearchFilter } from "./search-filter.ts";
```

and add to the returned array, after `emitServer(spec, target)`:

```ts
    // Seventh file, emitted only for a spec with a search tool — a read-only spec never
    // reaches this branch, which is what keeps the six-file fixtures byte-safe.
    ...((): GeneratedFile[] => {
      const f = emitSearchFilter(spec, target);
      return f === undefined ? [] : [f];
    })(),
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `bun test test/emit/search-filter.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the whole suite and the golden harness**

Run: `bun test && bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: all pass; four fixtures at `6/6` and still six files each.

- [ ] **Step 7: Commit**

```bash
git add src/emit/search-filter.ts src/emit/index.ts test/emit/search-filter.test.ts
git commit -m "feat(emit): emit src/search-filter.ts for search specs"
```

---

## Task 9: Conditional SDK floor and the README caveat

**Files:**
- Modify: `src/emit/package-json.ts:33-36`
- Modify: `src/emit/readme.ts`
- Test: `test/emit/static.test.ts`, `test/emit/readme.test.ts`

**Interfaces:**
- Consumes: `spec.tools`, `spec.style`, `target`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Append to `test/emit/static.test.ts`:

```ts
describe("SDK floor", () => {
  it("raises the floor to ^1.12.0 for a standalone search spec", () => {
    const pkg = JSON.parse(emitPackageJson(searchSpec, "standalone", "MIT").content);
    expect(pkg.dependencies["@nimbus-dev/sdk"]).toBe("^1.12.0");
  });

  it("leaves the floor at ^1.11.0 for a standalone spec with no search tool", () => {
    const pkg = JSON.parse(emitPackageJson(plainSpec, "standalone", "MIT").content);
    expect(pkg.dependencies["@nimbus-dev/sdk"]).toBe("^1.11.0");
  });

  it("leaves the monorepo floor at ^1.8.1 regardless of search", () => {
    const pkg = JSON.parse(emitPackageJson(searchSpec, "monorepo", "AGPL-3.0-only").content);
    expect(pkg.dependencies["@nimbus-dev/sdk"]).toBe("^1.8.1");
  });
});
```

Define `searchSpec` and `plainSpec` at the top of that describe block using `parseSpec`, following the existing file's fixture style — `searchSpec` carries one `impl: "search"` tool with `filter: { export: "f", fields: ["id"] }`, `plainSpec` one plain GET tool. Both use `style: "read-only-kit"` and an `inlineHeaders` fetch helper.

Append to `test/emit/readme.test.ts`:

```ts
it("explains that runReadOnly does not restrict writes, for read-only-kit only", () => {
  const withKit = emitReadme(readOnlyKitSpec, "standalone", "MIT").content;
  expect(withKit).toContain("does not restrict");
  const withoutKit = emitReadme(handRolledSpec, "standalone", "MIT").content;
  expect(withoutKit).not.toContain("does not restrict");
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test test/emit/static.test.ts test/emit/readme.test.ts`
Expected: FAIL — the floor is unconditional and the README has no such sentence.

- [ ] **Step 3: Implement the conditional floor**

In `src/emit/package-json.ts`, replace the `"@nimbus-dev/sdk"` line:

```ts
      // search-filter and matchesResult land in connector-kit in SDK 1.12.0. Only a spec
      // that names them needs that floor; raising it for everyone would strand users on a
      // version they have no reason to need.
      "@nimbus-dev/sdk": standalone
        ? spec.tools.some((t) => t.impl === "search")
          ? "^1.12.0"
          : "^1.11.0"
        : "^1.8.1",
```

- [ ] **Step 4: Implement the README caveat**

In `src/emit/readme.ts`, inside the `## What this is` section builder, append when `spec.style === "read-only-kit"`:

```ts
    ...(spec.style === "read-only-kit"
      ? [
          "",
          "This connector registers its tools through `runReadOnlyMcpConnector`. That name is a " +
            "bootstrap convention inherited from Nimbus and **does not restrict** the connector " +
            "from declaring write tools — nine connectors in the Nimbus corpus use it while " +
            "declaring `hitlRequired: [\"write\"]`. Check `nimbus.extension.json` for the " +
            "capabilities this connector actually declares.",
        ]
      : []),
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `bun test test/emit/static.test.ts test/emit/readme.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite and the golden harness**

Run: `bun test && bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: all pass; four fixtures at `6/6`. The README change is gated on the new style, so no existing fixture's README moves.

- [ ] **Step 7: Commit**

```bash
git add src/emit/package-json.ts src/emit/readme.ts test/emit/static.test.ts test/emit/readme.test.ts
git commit -m "feat(emit): conditional SDK floor and the runReadOnly README caveat"
```

---

## Task 10: The three real golden fixtures

**Files:**
- Create: `fixtures/mercury.spec.json`, `fixtures/zendesk.spec.json`, `fixtures/bitrise.spec.json`
- Modify: `fixtures/expectations.json`

**Interfaces:**
- Consumes: every emitter task above.
- Produces: three fixtures the diff harness reports on.

This is the task that proves Stage D. Expect it to fail on first run and to require emitter fixes — that is its purpose.

- [ ] **Step 1: Read the three real connectors**

Read, without copying any of it into this repository's source:

```
C:\gitrep\Nimbus\packages\mcp-connectors\mercury\src\server.ts
C:\gitrep\Nimbus\packages\mcp-connectors\mercury\src\search-filter.ts
C:\gitrep\Nimbus\packages\mcp-connectors\mercury\nimbus.extension.json
C:\gitrep\Nimbus\packages\mcp-connectors\zendesk\src\server.ts
C:\gitrep\Nimbus\packages\mcp-connectors\zendesk\src\search-filter.ts
C:\gitrep\Nimbus\packages\mcp-connectors\bitrise\src\server.ts
C:\gitrep\Nimbus\packages\mcp-connectors\bitrise\src\search-filter.ts
```

- [ ] **Step 2: Write `fixtures/mercury.spec.json`**

Transcribe the connector's parameters into the spec format. Follow `fixtures/newrelic.spec.json`'s shape. `mercury` uses a bearer token from `MERCURY_TOKEN`, base `https://api.mercury.com`, fetch helper local `mercuryGet`, and three tools: `mercury_list` (`/api/v1/accounts`), `mercury_get` (`/api/v1/account/${arg.id|enc}`), and `mercury_search` (`impl: "search"`, `rows: "accounts"`, filter export `filterMercuryAccounts` over `["id", "name", "status", "type", "kind", "legalBusinessName"]`). Copy the tool descriptions verbatim from the real `server.ts` — they are part of the bytes being matched.

- [ ] **Step 3: Add the expectation and run the diff**

In `fixtures/expectations.json`, add:

```json
  "mercury": [
    "README.md",
    "nimbus.extension.json",
    "package.json",
    "src/search-filter.ts",
    "src/server.ts",
    "test/sandbox.test.ts",
    "tsconfig.json"
  ],
```

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: `mercury` reports a diff. Read it.

- [ ] **Step 4: Close the diff**

Iterate: each remaining difference is either a spec field to set, or a real emitter defect to fix in the owning task's file. If a difference is irreducible, that is a documented limitation — record it in the spec's §5.2 rather than forcing the fixture. Do not change `expectations.json` to hide a mismatch.

Run after each change: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected, when done: `PASS  mercury  7/7 files identical`.

- [ ] **Step 5: Commit `mercury`**

```bash
git add fixtures/mercury.spec.json fixtures/expectations.json src/
git commit -m "test(golden): reproduce mercury byte-for-byte"
```

- [ ] **Step 6: Repeat for `zendesk`**

Same procedure. `zendesk`'s filter carries `{ tags: true }` — that is the axis this fixture exists for. Target `PASS  zendesk  7/7 files identical`.

```bash
git add fixtures/zendesk.spec.json fixtures/expectations.json src/
git commit -m "test(golden): reproduce zendesk byte-for-byte"
```

- [ ] **Step 7: Repeat for `bitrise`**

Same procedure. `bitrise`'s search tool declares an `appSlug` arg and therefore inlines its zod schema, and its search passes the response through with no `rows`. Target `PASS  bitrise  7/7 files identical`.

```bash
git add fixtures/bitrise.spec.json fixtures/expectations.json src/
git commit -m "test(golden): reproduce bitrise byte-for-byte"
```

- [ ] **Step 8: Confirm the four read fixtures did not move**

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: `newrelic`, `datadog`, `grafana`, `sentry` each `6/6`; the three new fixtures each `7/7`; every other fixture matching its declared expectation.

---

## Task 11: The two synthetic fixtures and standalone acceptance

**Files:**
- Create: `fixtures/zzsearch.spec.json`, `fixtures/zzsearchstub.spec.json`
- Modify: `fixtures/expectations.json`, `scripts/standalone-acceptance.ts` (fixture list)

**Interfaces:**
- Consumes: every emitter task.
- Produces: the standalone evidence for the search path.

- [ ] **Step 1: Write `fixtures/zzsearch.spec.json`**

A `read-only-kit` connector with a bearer env var, one plain GET tool, and two search tools: one with `rows` and no args (exercising `searchToolInputSchema`), one with an arg and no `rows` (exercising the inline schema). Both filters declare `fields`; one sets `tags: true`.

- [ ] **Step 2: Write `fixtures/zzsearchstub.spec.json`**

A `read-only-kit` connector with two search tools: one filter declaring `fields`, one omitting them. The mixed shape is deliberate — it is the case where the emitted import list must name `fieldsFromKeys`, `makeQueryFilter` **and** `SearchFilter`, and neither more nor less.

- [ ] **Step 3: Add both to `expectations.json` with an empty list**

```json
  "zzsearch": [],
  "zzsearchstub": [],
```

An empty list declares that no real connector should match — the same convention the `zzwrite` fixtures use.

- [ ] **Step 4: Run the golden harness**

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`
Expected: both report `0/7 files identical (expected partial)` and the run ends `All fixtures match their declared expectations.`

- [ ] **Step 5: Add both to the standalone acceptance fixture list**

In `scripts/standalone-acceptance.ts`, add `"zzsearch"` and `"zzsearchstub"` to the fixture array alongside the existing four.

- [ ] **Step 6: Run standalone acceptance against the local SDK checkout**

The registry does not yet have 1.12.0 (Task 12), so only local-checkout mode can pass.

Run: `bun run standalone-acceptance C:/gitrep/nimbus-sdk`
Expected: 6 fixtures × 10 checks, all `PASS`. **The `tsc --noEmit` and `bun run lint` checks on `zzsearchstub` are the point of this task** — they are what catches an unused import or an unread local in the stub path, which no substring assertion can see.

If the SDK checkout does not yet export `search-filter` from `connector-kit`, this run fails on `zzsearch`. That is the signal to do Task 12 first and return here.

- [ ] **Step 7: Commit**

```bash
git add fixtures/zzsearch.spec.json fixtures/zzsearchstub.spec.json fixtures/expectations.json scripts/standalone-acceptance.ts
git commit -m "test(standalone): cover the search and stub paths"
```

---

## Task 12: Nimbus SDK — publish the search kit

**Files (in `C:\gitrep\nimbus-sdk`, a separate repository):**
- Create: `sdks/typescript/src/connector-kit/search-filter.ts`
- Create: `sdks/typescript/src/connector-kit/search-filter.test.ts`
- Modify: `sdks/typescript/src/connector-kit/index.ts`

**Interfaces:**
- Produces: `@nimbus-dev/sdk/connector-kit` exports `asObjectish`, `asRecord`, `fieldsFromKeys`, `filterByQuery`, `makeQueryFilter`, `matchesResult`, `nestedString`, `stringField`, `tagNamesFromObjects`, `tagText`, and the types `FieldExtractor`, `FilterByQueryOptions`, `SearchFilter`, `SearchMatchOptions`.

This task is independent of Tasks 1-11 and can run in parallel from the start. It is the critical path for Task 11 Step 6.

- [ ] **Step 1: Branch the SDK repository**

```bash
git -C C:/gitrep/nimbus-sdk checkout -b feat/connector-kit-search
```

- [ ] **Step 2: Copy `search-filter.ts` verbatim**

Copy `C:\gitrep\Nimbus\packages\mcp-connectors\shared\search-filter.ts` to `sdks/typescript/src/connector-kit/search-filter.ts`. It has zero imports, so it needs no modification. Copy its test file alongside it.

- [ ] **Step 3: Add `matchesResult` and the `SearchFilter` type**

Append to the same file — **not** `searchToolInputSchema`, which needs zod and would break the SDK's `"dependencies": {}`:

```ts
import { type McpListResult, mcpJsonResult } from "./mcp-tool-kit.ts";

/** A `makeQueryFilter(...)` result — the shape every connector search filter has. */
export type SearchFilter = (
  rows: readonly unknown[],
  opts: SearchMatchOptions,
) => readonly unknown[];

/**
 * Build the `{ matches }` envelope: filter the rows when they are an array, else return an
 * empty match set. `rows` stays `unknown` because external payloads are untyped at the
 * boundary.
 */
export function matchesResult(
  rows: unknown,
  filter: SearchFilter,
  opts: SearchMatchOptions,
): McpListResult {
  const matches = Array.isArray(rows) ? filter(rows, opts) : [];
  return mcpJsonResult({ matches });
}
```

- [ ] **Step 4: Re-export from the barrel**

Add the named exports to `sdks/typescript/src/connector-kit/index.ts`, following the existing named-re-export style there.

- [ ] **Step 5: Verify the zero-dependency rule still holds**

Run, in `C:/gitrep/nimbus-sdk/sdks/typescript`:

```bash
node -e "console.log(JSON.stringify(require('./package.json').dependencies))"
```

Expected: `{}`.

Then run the SDK's own test, typecheck and API-surface guard — check its `package.json` scripts for the exact names, and run `api:surface` in particular, since it is what makes this new public surface visible in review.

- [ ] **Step 6: Commit and open the PR**

```bash
git -C C:/gitrep/nimbus-sdk add sdks/typescript/src/connector-kit/
git -C C:/gitrep/nimbus-sdk commit -m "feat(connector-kit): export the connector search kit"
```

Open the PR, get it merged, and release 1.12.0. Until that release is on the registry, Task 11 Step 6 runs only in local-checkout mode and Task 13's registry run cannot pass.

---

## Task 13: Final verification and documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-01-create-nimbus-connector-stage-d-design.md` (§9 acceptance results)

- [ ] **Step 1: Document the style and the search tool in the README**

Add a `### Search tools: impl, rows, maxLimit and filter` subsection under `## Scope`, following the shape of the existing `### Writes: method, effect and body` section. State the `rest-kit` exclusion and its reason, and state the stub behaviour.

- [ ] **Step 2: Run every gate and paste the real output**

Run each, and record the output verbatim — not summarised, not copied from this plan:

```bash
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run acceptance C:/gitrep/Nimbus
bun run standalone-acceptance --registry
bun run standalone-acceptance C:/gitrep/nimbus-sdk
```

Expected: all pass. `--registry` requires SDK 1.12.0 to be published (Task 12); if it is not, say so plainly rather than reporting the local-checkout run as though it were the registry run.

- [ ] **Step 3: Confirm both external repositories are clean**

```bash
git -C C:/gitrep/Nimbus status --short
git -C C:/gitrep/nimbus-sdk status --short
```

Expected: `Nimbus` shows only its pre-existing untracked `facebook-post.txt`. Confirm no `cnc-*` directory remains under `%TEMP%`.

- [ ] **Step 4: Write §9 Acceptance results into the spec**

Follow the Stage C spec's §9: paste observed output, and add a "Where a claim had to be qualified rather than asserted outright" subsection covering the three limits in §5.2 — in particular that the style alone is never byte-proven (§1.7).

- [ ] **Step 5: Commit and open the PR**

```bash
git add README.md docs/
git commit -m "docs: Stage D acceptance results"
gh pr create --title "feat: Stage D — the read-only-kit style and search tools" --body "..."
```

---

## Self-Review

**Spec coverage.** D1 → Tasks 1-3. D2 → Task 1 Step 4 (no rule forbids write tools) and Task 9's README caveat. D3 → Tasks 4-7, with the `rest-kit` exclusion in Task 5. D4 → Task 12 for the SDK half, Tasks 7-8 for the import split, Task 9 for the floor. D5 → Task 8 Step 3 `stubFilter`. D6 → Tasks 3, 7, 8 target branches. D7 → Task 3. §4.1's byte-safety invariant → the Global Constraints and every emitter task's golden-harness step. §5.1's five fixtures → Tasks 10-11. §5.2's limits → Task 13 Step 4.

**Previously an open gap, now closed.** An earlier draft left Task 8's monorepo import path unresolved, on the grounds that only a real `tsc` in Task 11 could settle it. That was wrong — reading the two shared modules settles it: `shared/search-filter.ts` does not export `SearchFilter` and `shared/mcp-search-tool.ts` does, so the monorepo stub path needs two import lines. Task 8 Step 3 now emits the split and Task 8's test pins it. Task 11 Step 6 remains the check that the whole file typechecks; it is no longer the place a known question gets answered.

**Type consistency.** `renderSearchTool(spec, tool)` is defined in Task 6 and called in Task 6 Step 4. `emitSearchFilter(spec, target)` is defined in Task 8 and called in Task 8 Step 4. `isHandStyle` exists twice deliberately — once in `src/spec.ts` (Task 1, module-private, takes a string) and once in `src/emit/server/index.ts` (Task 2, takes a `ConnectorSpec`); they are in different modules and neither is exported. `searchKitNames` / `filterImport` / `searchTools` are all defined and used within Task 7.
