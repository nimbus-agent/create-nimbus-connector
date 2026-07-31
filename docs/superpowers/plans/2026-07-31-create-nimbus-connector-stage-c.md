# create-nimbus-connector Stage C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the generator to emit connectors that write — non-GET methods, request bodies, accurate `hitlRequired`, and `client_credentials` auth — plus opt-in Gateway wiring, without moving a single byte of existing read-only output.

**Architecture:** Extend the existing emitters along one new axis rather than adding a parallel path (spec §2, approach A). A write helper is emitted *only* when a spec contains a non-GET tool, so read-only specs never reach the new code and the four 6/6 golden fixtures are byte-safe by construction. Writes are verified by golden snapshots of our own output, because the corpus offers no reproducible reference (spec §1.3).

**Tech Stack:** Bun 1.3.14, TypeScript, Zod 4, Biome (optional dep), `@nimbus-dev/sdk@^1.11.0`.

## Global Constraints

- **Bun only.** No Node, npm or pnpm in `src/`, `test/`, `scripts/`, or generated output. The sole exception is `release.yml`'s `npm publish --provenance`.
- **This repo is MIT; the Nimbus monorepo is AGPL-3.0-only.** No connector source may be copied here — not into `src/`, `test/`, `fixtures/`, or docs.
- **`diff:golden` must stay green after every task.** It currently passes 9 fixtures; Task 8 raises it to 11. `newrelic`, `datadog`, `grafana`, `sentry` must remain 6/6 throughout.
- **Backward compatible.** `create-nimbus-connector@0.2.2` is published. `impl: "get"` must keep working; every schema addition is optional with a default.
- **Conventional commits.** `feat:`/`fix:` cut releases; `chore:`/`ci:`/`docs:`/`test:`/`refactor:` do not.
- **Every `src/emit/**` change must be proven output-neutral for read-only specs** before commit, by running `diff:golden`.
- Run `bunx biome check --write` before committing; CI runs `bun run lint`, which cannot fetch from the registry.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/spec.ts` | `method`, `effect`, `body` on `ToolSchema`; `impl: "rest"`; `client-credentials` on `EnvSchema`; all new refines | 1, 6 |
| `src/emit/manifest.ts` | Compute `hitlRequired` from tool effects | 2 |
| `src/emit/server/body.ts` | **New.** Render a JSON body expression from args + optional mapping | 3 |
| `src/emit/server/fetch-helper.ts` | Emit the second (write) helper for hand-rolled specs | 4 |
| `src/emit/server/tools-hand.ts` | Route non-GET tools through the write helper | 4 |
| `src/emit/server/tools-rest.ts` | Pass `buildInit` as the registrar's 5th argument | 5 |
| `src/emit/server/env.ts` | Emit the `client-credentials` token function | 6 |
| `src/golden/snapshots.ts` | **New.** Load, compare and report snapshot trees | 7 |
| `scripts/snapshot-update.ts` | **New.** Explicit snapshot regeneration with a change summary | 7 |
| `test/golden/snapshots.test.ts` | **New.** Compare generated output against checked-in snapshots | 7 |
| `fixtures/zzwrite.spec.json` | **New.** Hand-rolled write fixture | 8 |
| `fixtures/zzwriterest.spec.json` | **New.** rest-kit write fixture | 8 |
| `scripts/standalone-acceptance.ts` | Add both write fixtures to `FIXTURES` | 8 |
| `src/emit/wiring.ts` | **New.** Emit `<name>-sync.ts` + `<name>-mapping.ts` stub | 10 |
| `src/cli.ts` | `--gateway-wiring <nimbus-root>` flag | 10 |

**Verified before planning** (do not re-derive): the published `@nimbus-dev/sdk@1.11.0` `makeRestToolRegistrar` already accepts a 5th parameter `buildInit?: (args: T) => RequestInit`. Task 5 needs **no** SDK change.

---

## Task 1: Schema — `method`, `effect`, `body`, `impl: "rest"`

**Files:**
- Modify: `src/spec.ts:44-64` (`ToolSchema`)
- Test: `test/spec.test.ts`

**Interfaces:**
- Produces: `ToolSpec` gains `method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE"` (default `"GET"`), `effect: "read"|"write"|"delete"` (default `"read"`), `body?: Record<string,string>`. `impl` becomes `"rest"|"stub"` with `"get"` normalised to `"rest"`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/spec.test.ts
import { describe, expect, it } from "bun:test";
import { parseSpec } from "../src/spec.ts";

const base = {
  name: "zz", title: "Zz", displayName: "Zz", description: "d.", serviceLabel: "Zz",
  style: "hand-rolled", network: ["api.zz.test"], syncInterval: 300, minNimbusVersion: "0.2.0",
  env: [{ vars: ["ZZ_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }],
  fetchHelper: { local: "zzGet", base: "https://api.zz.test", headers: "headers" },
};
const tool = (o: Record<string, unknown>) => ({ ...base, tools: [{ name: "zz_a", description: "A.", ...o }] });

describe("Stage C tool fields", () => {
  it("defaults method to GET and effect to read", () => {
    const s = parseSpec(tool({ path: "/a" }));
    expect(s.tools[0]!.method).toBe("GET");
    expect(s.tools[0]!.effect).toBe("read");
  });

  it("accepts impl 'get' as a deprecated alias for 'rest'", () => {
    // 0.2.2 is published; specs already written must keep working.
    expect(parseSpec(tool({ path: "/a", impl: "get" })).tools[0]!.impl).toBe("rest");
  });

  it("allows POST with effect read — a GraphQL query is not a write", () => {
    const s = parseSpec(tool({ path: "/g", method: "POST", effect: "read" }));
    expect(s.tools[0]!.effect).toBe("read");
  });

  it("rejects a mutating GET", () => {
    expect(() => parseSpec(tool({ path: "/a", effect: "write" }))).toThrow(/GET/);
  });

  it("rejects a body on GET", () => {
    expect(() => parseSpec(tool({ path: "/a", body: { x: "x" } }))).toThrow(/body/i);
  });

  it("rejects method or body on a stub", () => {
    expect(() => parseSpec(tool({ impl: "stub", method: "POST" }))).toThrow(/stub/i);
    expect(() => parseSpec(tool({ impl: "stub", body: { x: "x" } }))).toThrow(/stub/i);
  });

  it("rejects a body key naming an undeclared arg", () => {
    expect(() =>
      parseSpec(tool({ path: "/a", method: "POST", args: { title: { type: "string" } }, body: { api_title: "nope" } })),
    ).toThrow(/nope/);
  });

  it("allows DELETE with effect write", () => {
    // Deleting a webhook subscription is not destructive to user data.
    expect(parseSpec(tool({ path: "/a", method: "DELETE", effect: "write" })).tools[0]!.effect).toBe("write");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/spec.test.ts`
Expected: FAIL — `method` and `effect` are unrecognised keys (`ToolSchema` is a `strictObject`).

- [ ] **Step 3: Implement**

Replace `ToolSchema` in `src/spec.ts`:

```ts
export const ToolSchema = z
  .strictObject({
    name: z.string().min(1),
    description: z.string().min(1),
    args: z
      .record(
        z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "argument name must be a valid JS identifier"),
        ArgSchema,
      )
      .default({}),
    path: z.string().optional(),
    // "get" is the Stage A spelling. It became wrong the moment `method` existed, but
    // 0.2.2 is published, so it is normalised rather than rejected.
    impl: z
      .enum(["rest", "get", "stub"])
      .default("rest")
      .transform((v) => (v === "get" ? "rest" : v)),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    /**
     * The author's declaration of intent, deliberately NOT derived from `method`.
     * Measured against the 94 connectors, method-derived HITL matches only 62 — dagster
     * POSTs GraphQL queries, ramp and wiz POST to exchange tokens.
     */
    effect: z.enum(["read", "write", "delete"]).default("read"),
    /** arg name -> API field name. Omitted means "the args object is the body". */
    body: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .refine((t) => (t.impl === "stub") === (t.path === undefined), {
    message:
      '"path" is required when "impl" is not "stub", and must be omitted when "impl" is "stub" ' +
      '— "impl" and "path" disagree',
  })
  .refine((t) => !(t.impl === "stub" && (t.method !== "GET" || t.body !== undefined)), {
    message: 'a "stub" tool issues no request, so "method" and "body" have nothing to describe',
  })
  .refine((t) => !(t.method === "GET" && t.effect !== "read"), {
    message:
      'a GET tool cannot have effect "write" or "delete" — a REST GET that mutates is a bug, ' +
      "not a design. Set the method the API actually requires.",
  })
  .refine((t) => !(t.body !== undefined && t.method === "GET"), {
    message: '"body" requires a non-GET "method"',
  })
  // superRefine only, deliberately: a parallel .refine asserting the same condition would
  // fire alongside this one with a vaguer message, and the test asserts the offending key
  // name appears in the error. One check, one message, naming the key that is wrong.
  .superRefine((t, ctx) => {
    if (t.body === undefined) return;
    for (const k of Object.keys(t.body)) {
      if (!(k in t.args)) {
        ctx.addIssue({ code: "custom", message: `"body" key "${k}" is not a declared arg` });
      }
    }
  });
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test test/spec.test.ts` → PASS.
Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus` → 9/9, exit 0. The eight fixtures use `impl: "get"` or omit it; both now normalise to `"rest"` and emit identical output.

- [ ] **Step 5: Update the fixtures to the new spelling**

Change `"impl": "get"` to `"impl": "rest"` in every `fixtures/*.spec.json` that sets it. These are *inputs*, not golden output.

Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus` → still 9/9. If any fixture moves, stop: the alias is not behaving as an alias.

- [ ] **Step 6: Commit**

```bash
git add src/spec.ts test/spec.test.ts fixtures/
git commit -m "feat(spec): add method, effect and body to tools

method and effect are independent because the corpus proves they are:
deriving hitlRequired from HTTP methods matches only 62 of 94 connectors.
dagster POSTs GraphQL queries; ramp and wiz POST to exchange tokens.

impl gains \"rest\" and normalises the published \"get\" spelling rather than
rejecting it — 0.2.2 is on npm and specs written against it must keep working."
```

---

## Task 2: `hitlRequired` computed from effects

**Files:**
- Modify: `src/emit/manifest.ts`
- Test: `test/emit/manifest.test.ts`

**Interfaces:**
- Consumes: `ToolSpec.effect` from Task 1.
- Produces: `emitManifest` emits `hitlRequired` as the sorted unique set of non-`read` effects.

- [ ] **Step 1: Write the failing test**

```ts
// test/emit/manifest.test.ts
import { describe, expect, it } from "bun:test";
import { emitManifest } from "../../src/emit/manifest.ts";
import { parseSpec } from "../../src/spec.ts";

const spec = (tools: unknown[]) =>
  parseSpec({
    name: "zz", title: "Zz", displayName: "Zz", description: "d.", serviceLabel: "Zz",
    style: "hand-rolled", network: ["api.zz.test"], syncInterval: 300, minNimbusVersion: "0.2.0",
    env: [{ vars: ["ZZ_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }],
    fetchHelper: { local: "zzGet", base: "https://api.zz.test", headers: "headers" },
    tools,
  });

const hitl = (tools: unknown[]) =>
  JSON.parse(emitManifest(spec(tools)).content).hitlRequired as string[];

describe("hitlRequired", () => {
  it("is empty for a read-only connector", () => {
    expect(hitl([{ name: "a", description: "A.", path: "/a" }])).toEqual([]);
  });

  it("collects write", () => {
    expect(hitl([{ name: "a", description: "A.", path: "/a", method: "POST", effect: "write" }])).toEqual(["write"]);
  });

  it("sorts delete before write, matching all 37 manifests that declare them", () => {
    expect(
      hitl([
        { name: "a", description: "A.", path: "/a", method: "POST", effect: "write" },
        { name: "b", description: "B.", path: "/b", method: "DELETE", effect: "delete" },
      ]),
    ).toEqual(["delete", "write"]);
  });

  it("deduplicates", () => {
    expect(
      hitl([
        { name: "a", description: "A.", path: "/a", method: "POST", effect: "write" },
        { name: "b", description: "B.", path: "/b", method: "PUT", effect: "write" },
      ]),
    ).toEqual(["write"]);
  });

  it("counts a stub's declared effect — over-declaring asks for a needless approval, under-declaring lets a mutation past review", () => {
    expect(hitl([{ name: "a", description: "A.", impl: "stub", effect: "write" }])).toEqual(["write"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/manifest.test.ts`
Expected: FAIL — `hitlRequired` is hardcoded `[]`.

- [ ] **Step 3: Implement**

In `src/emit/manifest.ts`, replace `hitlRequired: [] as string[]`:

```ts
    hitlRequired: hitlRequired(spec),
```

and add above `emitManifest`:

```ts
/**
 * The sorted unique set of non-read effects.
 *
 * Computed rather than declared: 32 of the 94 monorepo connectors have a hand-written
 * hitlRequired that disagrees with their tools, which is what a hand-maintained
 * capability list does over time.
 */
function hitlRequired(spec: ConnectorSpec): string[] {
  const effects = new Set(spec.tools.map((t) => t.effect).filter((e) => e !== "read"));
  return [...effects].sort();
}
```

`sort()` puts `delete` before `write` alphabetically, which is the order all 37 declaring manifests use.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/emit/manifest.test.ts` → PASS.
Run: `bun run diff:golden --nimbus-root C:/gitrep/Nimbus` → 9/9. Every fixture is read-only, so every one still computes `[]`.

- [ ] **Step 5: Commit**

```bash
git add src/emit/manifest.ts test/emit/manifest.test.ts
git commit -m "feat(emit): compute hitlRequired from tool effects"
```

---

## Task 3: Body rendering

**Files:**
- Create: `src/emit/server/body.ts`
- Test: `test/emit/server/body.test.ts`

**Interfaces:**
- Produces: `renderBodyExpr(tool: ToolSpec, param: string): string | undefined` — returns a `JSON.stringify(...)` expression, or `undefined` when the tool sends no body.

- [ ] **Step 1: Write the failing test**

```ts
// test/emit/server/body.test.ts
import { describe, expect, it } from "bun:test";
import { renderBodyExpr } from "../../../src/emit/server/body.ts";
import { parseSpec } from "../../../src/spec.ts";

const toolOf = (o: Record<string, unknown>) =>
  parseSpec({
    name: "zz", title: "Zz", displayName: "Zz", description: "d.", serviceLabel: "Zz",
    style: "hand-rolled", network: ["api.zz.test"], syncInterval: 300, minNimbusVersion: "0.2.0",
    env: [{ vars: ["ZZ_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }],
    fetchHelper: { local: "zzGet", base: "https://api.zz.test", headers: "headers" },
    tools: [{ name: "zz_a", description: "A.", ...o }],
  }).tools[0]!;

describe("renderBodyExpr", () => {
  it("returns undefined for a GET", () => {
    expect(renderBodyExpr(toolOf({ path: "/a" }), "p")).toBeUndefined();
  });

  it("returns undefined for a non-GET with no args — a DELETE sends no body", () => {
    expect(renderBodyExpr(toolOf({ path: "/a", method: "DELETE", effect: "delete" }), "p")).toBeUndefined();
  });

  it("uses the args object, preserving declared types", () => {
    const t = toolOf({ path: "/a", method: "POST", effect: "write", args: { title: { type: "string" }, count: { type: "number" } } });
    expect(renderBodyExpr(t, "p")).toBe("JSON.stringify({ title: p.title, count: p.count })");
  });

  it("renames keys under an explicit mapping", () => {
    const t = toolOf({ path: "/a", method: "POST", effect: "write", args: { title: { type: "string" } }, body: { title: "issue_title" } });
    expect(renderBodyExpr(t, "p")).toBe('JSON.stringify({ issue_title: p.title })');
  });

  it("quotes an API field name that is not a JS identifier", () => {
    const t = toolOf({ path: "/a", method: "POST", effect: "write", args: { title: { type: "string" } }, body: { title: "issue-title" } });
    expect(renderBodyExpr(t, "p")).toBe('JSON.stringify({ "issue-title": p.title })');
  });

  it("omits args that the mapping does not name", () => {
    const t = toolOf({ path: "/a", method: "POST", effect: "write", args: { title: { type: "string" }, id: { type: "string" } }, body: { title: "t" } });
    expect(renderBodyExpr(t, "p")).toBe("JSON.stringify({ t: p.title })");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/server/body.test.ts`
Expected: FAIL — `src/emit/server/body.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
// src/emit/server/body.ts
import type { ToolSpec } from "../../spec.ts";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The JSON body expression for a tool, or undefined when it sends none.
 *
 * The args object IS the body by default, which is the shape the corpus uses
 * (`JSON.stringify({ issueId, status })`). Arg values are referenced directly rather
 * than interpolated into a string, so a number arg stays a number in the JSON.
 */
export function renderBodyExpr(tool: ToolSpec, param: string): string | undefined {
  if (tool.method === "GET") return undefined;

  const pairs =
    tool.body === undefined
      ? Object.keys(tool.args).map((a) => [a, a] as const)
      : Object.entries(tool.body).map(([arg, field]) => [field, arg] as const);

  if (pairs.length === 0) return undefined;

  const fields = pairs
    .map(([field, arg]) => `${IDENT.test(field) ? field : JSON.stringify(field)}: ${param}.${arg}`)
    .join(", ");
  return `JSON.stringify({ ${fields} })`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/emit/server/body.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/emit/server/body.ts test/emit/server/body.test.ts
git commit -m "feat(emit): render request bodies from tool args"
```

---

## Task 4: hand-rolled write helper and tool routing

**Files:**
- Modify: `src/emit/server/fetch-helper.ts`, `src/emit/server/tools-hand.ts`
- Test: `test/emit/server/tools-hand.test.ts`

**Interfaces:**
- Consumes: `renderBodyExpr` (Task 3).
- Produces: `renderWriteHelper(spec): string | undefined` in `fetch-helper.ts`, returning `undefined` when no tool is non-GET. The emitted helper is named `${spec.fetchHelper.local}Send`.

- [ ] **Step 1: Write the failing test**

```ts
// append to test/emit/server/tools-hand.test.ts
import { renderWriteHelper } from "../../../src/emit/server/fetch-helper.ts";

describe("hand-rolled write support", () => {
  const spec = (tools: unknown[]) =>
    parseSpec({
      name: "zz", title: "Zz", displayName: "Zz", description: "d.", serviceLabel: "Zz",
      style: "hand-rolled", network: ["api.zz.test"], syncInterval: 300, minNimbusVersion: "0.2.0",
      env: [{ vars: ["ZZ_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }],
      fetchHelper: { local: "zzGet", base: "https://api.zz.test", headers: "headers" },
      tools,
    });

  it("emits NO write helper for a read-only spec — this is what keeps the 6/6 fixtures byte-identical", () => {
    expect(renderWriteHelper(spec([{ name: "a", description: "A.", path: "/a" }]))).toBeUndefined();
  });

  it("emits a write helper when any tool is non-GET", () => {
    const out = renderWriteHelper(spec([{ name: "a", description: "A.", path: "/a", method: "POST", effect: "write" }]));
    expect(out).toContain("async function zzGetSend(");
    expect(out).toContain("method,");
    expect(out).toContain('"Content-Type": "application/json"');
  });

  it("routes a write tool through the write helper with method and body", () => {
    const out = renderHandRolledTools(
      spec([{ name: "zz_create", description: "C.", path: "/i", method: "POST", effect: "write", args: { title: { type: "string" } } }]),
    );
    expect(out).toContain('zzGetSend(`/i`, "POST", JSON.stringify({ title: p.title }))');
  });

  it("sends no body on a DELETE with no args", () => {
    const out = renderHandRolledTools(
      spec([{ name: "zz_rm", description: "R.", path: "/i", method: "DELETE", effect: "delete" }]),
    );
    expect(out).toContain('zzGetSend(`/i`, "DELETE", undefined)');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/server/tools-hand.test.ts`
Expected: FAIL — `renderWriteHelper` is not exported.

- [ ] **Step 3: Implement the helper**

Add to `src/emit/server/fetch-helper.ts`:

```ts
/**
 * The write helper, or undefined when the spec has no non-GET tool.
 *
 * Emitting it conditionally is what makes Stage C byte-safe: a read-only spec never
 * reaches this function, so newrelic/datadog/grafana/sentry cannot move. It also mirrors
 * the corpus — argocd has agPost because argocd posts.
 */
export function renderWriteHelper(spec: ConnectorSpec): string | undefined {
  if (!spec.tools.some((t) => t.method !== "GET")) return undefined;
  if (spec.style === "rest-kit") return undefined; // the registrar's buildInit carries it

  const fh = spec.fetchHelper;
  const url = `\`${resolveEnvRefs(fh.base)}\${path}\``;
  return [
    `async function ${fh.local}Send(`,
    "  path: string,",
    "  method: string,",
    "  body: string | undefined,",
    "): Promise<unknown> {",
    `  const res = await fetch(${url}, {`,
    "    method,",
    `    headers: { ...${fh.headers ?? "headers"}(), "Content-Type": "application/json" },`,
    "    ...(body === undefined ? {} : { body }),",
    "  });",
    "  const text = await res.text();",
    "  if (!res.ok) {",
    `    throw new Error(\`${spec.serviceLabel} \${String(res.status)}: \${text.slice(0, 400)}\`);`,
    "  }",
    "  try {",
    "    return JSON.parse(text) as unknown;",
    "  } catch {",
    "    return null;",
    "  }",
    "}",
  ].join("\n");
}
```

- [ ] **Step 4: Route write tools in `tools-hand.ts`**

In `renderTool`, after `const pathExpr = ...`, branch on method:

```ts
  if (tool.method !== "GET") {
    const bodyExpr = renderBodyExpr(tool, PARAM) ?? "undefined";
    const call = `${spec.fetchHelper.local}Send(${pathExpr}, ${JSON.stringify(tool.method)}, ${bodyExpr})`;
    // Same jsonResult wrapper the read path uses.
    return [...head, `  async (${PARAM}) => jsonResult(await ${call}),`, ");"].join("\n");
  }
```

Import `renderBodyExpr` from `./body.ts`.

- [ ] **Step 5: Wire the helper into the server emitter**

In `src/emit/server/index.ts`, emit `renderWriteHelper(spec)` immediately after the read helper when it is not `undefined`.

- [ ] **Step 6: Run every gate**

```bash
bun test
bunx tsc --noEmit
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
```

Expected: tests PASS, tsc exit 0, **diff:golden 9/9 with newrelic/datadog/grafana/sentry still 6/6**. If any of those four moved, the conditional emission is leaking into read-only specs — stop and fix before continuing.

- [ ] **Step 7: Commit**

```bash
git add src/emit/server/ test/emit/server/
git commit -m "feat(emit): hand-rolled write helper and non-GET routing

The helper is emitted only when a spec has a non-GET tool, so read-only specs
reach none of this code and the four 6/6 golden fixtures cannot move."
```

---

## Task 5: rest-kit writes via `buildInit`

**Files:**
- Modify: `src/emit/server/tools-rest.ts`
- Test: `test/emit/server/tools-rest.test.ts`

**Interfaces:**
- Consumes: `renderBodyExpr` (Task 3).
- Produces: a 5th argument to the registrar call for non-GET tools.

**Verified:** `@nimbus-dev/sdk@1.11.0` already publishes `buildInit?: (args: T) => RequestInit` as the registrar's 5th parameter. No SDK change is needed.

- [ ] **Step 1: Write the failing test**

```ts
describe("rest-kit writes", () => {
  it("passes method and body as buildInit", () => {
    const out = renderRestKitTools(
      restSpec([{ name: "zz_create", description: "C.", path: "/i", method: "POST", effect: "write", args: { title: { type: "string" } } }]),
    );
    expect(out).toContain('({ method: "POST", body: JSON.stringify({ title: parsed.title }) })');
  });

  it("emits no 5th argument for a GET — read-only rest-kit output must not change", () => {
    const out = renderRestKitTools(restSpec([{ name: "zz_a", description: "A.", path: "/a" }]));
    expect(out).not.toContain("method:");
  });
});
```

(`restSpec` mirrors the hand-rolled helper in this file but with `style: "rest-kit"` and a `fetchHelper` without `headers`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/server/tools-rest.test.ts` → FAIL, no `method:` in output.

- [ ] **Step 3: Implement**

In `renderTool` of `tools-rest.ts`, build the init argument and append it:

```ts
  const bodyExpr = renderBodyExpr(tool, PARAM);
  const initArg =
    tool.method === "GET"
      ? undefined
      : `  (${PARAM}) => ({ method: ${JSON.stringify(tool.method)}` +
        (bodyExpr === undefined ? "" : `, body: ${bodyExpr}`) +
        " }),";
```

Append `initArg` after the path argument in both the inline and hoisted return paths, skipping it when `undefined`.

- [ ] **Step 4: Run every gate**

```bash
bun test
bunx tsc --noEmit
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
```

Expected: PASS, exit 0, 9/9. `discord` and `google-meet` are the rest-kit fixtures — their expectations must not move.

- [ ] **Step 5: Commit**

```bash
git add src/emit/server/tools-rest.ts test/emit/server/tools-rest.test.ts
git commit -m "feat(emit): rest-kit writes through the registrar's buildInit"
```

---

## Task 6: `client-credentials` auth

**Files:**
- Modify: `src/spec.ts` (`EnvSchema`), `src/emit/server/env.ts`
- Test: `test/emit/server/env.test.ts`

**Interfaces:**
- Produces: `EnvSchema` accepts `auth: "client-credentials"` with `tokenUrl: string`, `scope?: string`, `credentialsIn: "basic" | "body"`.

- [ ] **Step 1: Write the failing test**

```ts
describe("client-credentials", () => {
  const ccSpec = (over: Record<string, unknown> = {}) =>
    parseSpec({
      name: "zz", title: "Zz", displayName: "Zz", description: "d.", serviceLabel: "Zz",
      style: "hand-rolled", network: ["api.zz.test"], syncInterval: 300, minNimbusVersion: "0.2.0",
      env: [{
        vars: ["ZZ_CLIENT_ID", "ZZ_CLIENT_SECRET"], local: "authHeaders", bindings: ["id", "secret"],
        auth: "client-credentials", tokenUrl: "https://api.zz.test/token",
        scope: "items:read", credentialsIn: "basic", ...over,
      }],
      fetchHelper: { local: "zzGet", base: "https://api.zz.test", headers: "authHeaders" },
      tools: [{ name: "zz_a", description: "A.", path: "/a" }],
    });

  it("requires exactly two vars", () => {
    expect(() => ccSpec({ vars: ["ONLY_ONE"] })).toThrow(/two/i);
  });

  it("rejects rest-kit style — the registrar resolves one bearer credential itself", () => {
    expect(() =>
      parseSpec({ ...JSON.parse(JSON.stringify(ccSpec())), style: "rest-kit",
        fetchHelper: { local: "zzGet", base: "https://api.zz.test" } }),
    ).toThrow(/hand-rolled/);
  });

  it("emits a cached token function and a Bearer header", () => {
    const out = renderEnvAccessors(ccSpec());
    expect(out).toContain("let cachedToken: string | null = null");
    expect(out).toContain('grant_type: "client_credentials"');
    expect(out).toContain("Authorization: `Bearer ${await token()}`");
  });

  it("sends credentials as a Basic header when credentialsIn is basic", () => {
    expect(renderEnvAccessors(ccSpec())).toContain("Authorization: `Basic ${");
  });

  it("sends them in the form body when credentialsIn is body", () => {
    const out = renderEnvAccessors(ccSpec({ credentialsIn: "body" }));
    expect(out).toContain("client_secret");
    expect(out).not.toContain("Authorization: `Basic ${");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/emit/server/env.test.ts` → FAIL, `client-credentials` is not in the auth enum.

- [ ] **Step 3: Extend `EnvSchema`**

```ts
    auth: z.enum(["bearer", "headers", "client-credentials"]).optional(),
    /** Token endpoint, required when auth === "client-credentials". */
    tokenUrl: z.string().url().optional(),
    scope: z.string().min(1).optional(),
    /** ramp sends Basic; powerbi, looker and teams put client_secret in the body. */
    credentialsIn: z.enum(["basic", "body"]).optional(),
```

Add refines: `client-credentials` requires `tokenUrl`, `credentialsIn`, and exactly two `vars`; `tokenUrl`, `scope` and `credentialsIn` are rejected unless `auth === "client-credentials"`. Add a spec-level refine rejecting `client-credentials` when `style === "rest-kit"`, with the message: `'style "rest-kit" cannot use client-credentials: makeRestToolRegistrar resolves a single bearer credential itself and has no seam for a token exchange. Use style "hand-rolled".'`

- [ ] **Step 4: Emit the token function**

In `src/emit/server/env.ts`, when an entry has `auth: "client-credentials"`, emit:

```ts
let cachedToken: string | null = null;

// Cached for the process lifetime and never refreshed, matching ramp and wiz. Correct
// only because connectors are spawned per invocation and are short-lived — no connector
// in the corpus reads expires_in. A long-lived connector would use a stale token.
async function token(): Promise<string> {
  if (cachedToken !== null) return cachedToken;
  // Built incrementally, not as an object literal: URLSearchParams stringifies its values,
  // so `{ scope: undefined }` would send the literal `scope=undefined` to the token
  // endpoint. Emit the `set` line only when the spec declares a scope.
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  body.set("scope", SCOPE);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`<label> token exchange ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as { access_token?: unknown };
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
    throw new Error("<label> token response missing access_token");
  }
  cachedToken = parsed.access_token;
  return cachedToken;
}
```

For `credentialsIn: "basic"`, emit `Authorization: encodeBasicAuthHeader(id(), secret())` in the token request headers and add `encodeBasicAuthHeader` to the kit import.

**Not `btoa`.** `btoa` throws `InvalidCharacterError` on any character above U+00FF, so a secret containing one would fail at runtime rather than at parse time. `encodeBasicAuthHeader` is already exported by `@nimbus-dev/sdk@1.11.0`, does `Buffer.from(raw, "utf8").toString("base64")`, and returns the complete `Basic <b64>` value. It is also what the corpus does — `ramp` encodes exactly this way, and no connector uses `btoa` at all. Reusing the kit means less emitted code and one less thing to get wrong.

For `credentialsIn: "body"`, add `client_id` and `client_secret` to the `URLSearchParams` via `set` and emit no `Authorization` header on the token request.

- [ ] **Step 5: Run every gate**

```bash
bun test && bunx tsc --noEmit && bun run diff:golden --nimbus-root C:/gitrep/Nimbus
```

Expected: PASS, exit 0, 9/9 — no fixture uses `client-credentials`.

- [ ] **Step 6: Commit**

```bash
git add src/spec.ts src/emit/server/env.ts test/emit/server/env.test.ts
git commit -m "feat(spec,emit): client_credentials auth

The only grant type the corpus uses: five connectors exchange tokens and all
five are client_credentials. The emitted cache never expires, which is correct
only because connectors are short-lived; the comment records that dependency."
```

---

## Task 7: Golden snapshots

**Files:**
- Create: `src/golden/snapshots.ts`, `scripts/snapshot-update.ts`, `test/golden/snapshots.test.ts`
- Modify: `package.json` (add `snapshot:update` script)

**Interfaces:**
- Produces: `loadSnapshot(dir): Map<string,string>`, `compareSnapshot(actual, expected): SnapshotDiff`, where `SnapshotDiff = { missing: string[]; unexpected: string[]; changed: string[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/golden/snapshots.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareSnapshot, loadSnapshot } from "../../src/golden/snapshots.ts";

describe("compareSnapshot", () => {
  it("reports nothing when the trees match", () => {
    const m = new Map([["a.ts", "x"]]);
    expect(compareSnapshot(m, new Map(m))).toEqual({ missing: [], unexpected: [], changed: [] });
  });

  it("reports a changed file", () => {
    expect(compareSnapshot(new Map([["a.ts", "y"]]), new Map([["a.ts", "x"]])).changed).toEqual(["a.ts"]);
  });

  it("reports a file the generator stopped emitting", () => {
    expect(compareSnapshot(new Map(), new Map([["a.ts", "x"]])).missing).toEqual(["a.ts"]);
  });

  it("reports a file the generator started emitting", () => {
    expect(compareSnapshot(new Map([["b.ts", "x"]]), new Map()).unexpected).toEqual(["b.ts"]);
  });

  // Non-emptiness is loadSnapshot's job, not compareSnapshot's. compareSnapshot is a pure
  // diff over two trees and must stay total — given an empty expected tree it reports every
  // actual file as `unexpected`, which is a loud, correct answer rather than a throw.
  //
  // The vacuous-pass risk lives one level up: a snapshot directory that is absent or empty
  // must not silently compare nothing and report success. Stage A shipped a harness that
  // printed "All fixtures byte-identical" on zero fixtures; loadSnapshot is where that is
  // prevented for snapshots.
  it("reports every actual file as unexpected against an empty tree, rather than throwing", () => {
    expect(compareSnapshot(new Map([["a.ts", "x"]]), new Map()).unexpected).toEqual(["a.ts"]);
  });

  it("refuses to load a missing snapshot directory", () => {
    expect(() => loadSnapshot("does/not/exist")).toThrow(/no snapshot/i);
  });

  it("refuses to load a snapshot directory containing no files", () => {
    const empty = mkdtempSync(join(tmpdir(), "cnc-snap-empty-"));
    try {
      expect(() => loadSnapshot(empty)).toThrow(/no snapshot/i);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/golden/snapshots.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement `src/golden/snapshots.ts`**

`loadSnapshot(dir)` walks the directory and returns a `Map` of POSIX-relative path → content, and **throws** when the directory is absent or contains no files. `compareSnapshot(actual, expected)` returns sorted `missing`/`unexpected`/`changed` arrays.

- [ ] **Step 4: Add the comparison test for the real fixtures**

A second `describe` in the same file generates each write fixture with `generate(spec, { target: "standalone" })`, runs `formatAll`, and compares against `fixtures/snapshots/<name>/`. It asserts the snapshot set is non-empty before comparing.

- [ ] **Step 5: Implement `scripts/snapshot-update.ts`**

Regenerates every snapshot and prints a per-file summary (`+ added`, `~ changed`, `- removed`) plus a total. It is the **only** way snapshots change; CI never runs it.

Add to `package.json`: `"snapshot:update": "bun scripts/snapshot-update.ts"`.

- [ ] **Step 6: Commit**

```bash
git add src/golden/snapshots.ts scripts/snapshot-update.ts test/golden/snapshots.test.ts package.json
git commit -m "test: golden snapshots of generated output

Writes cannot be byte-matched against the corpus — 18 helpers, 18 distinct
shapes — so they are pinned against our own output instead. Updating is a
separate explicit command that prints what changed; CI only ever compares."
```

---

## Task 8: Write fixtures end to end

**Files:**
- Create: `fixtures/zzwrite.spec.json`, `fixtures/zzwriterest.spec.json`, `fixtures/snapshots/**`
- Modify: `fixtures/expectations.json`, `test/golden/expectations.test.ts`, `scripts/standalone-acceptance.ts`

- [ ] **Step 1: Write both fixtures**

`zzwrite` — hand-rolled, `client-credentials`, with a GET tool, a POST `effect: "write"` tool with args, and a DELETE `effect: "delete"` tool.
`zzwriterest` — rest-kit, bearer auth, with a GET tool and a PATCH `effect: "write"` tool.

- [ ] **Step 2: Declare their expectations**

Add `"zzwrite": []` and `"zzwriterest": []` to `fixtures/expectations.json`, and both names to the sorted list in `test/golden/expectations.test.ts`.

- [ ] **Step 3: Generate the snapshots**

Run: `bun run snapshot:update`. Read the printed file list. Confirm the emitted `nimbus.extension.json` shows `"hitlRequired": ["delete", "write"]` for `zzwrite` and `["write"]` for `zzwriterest`.

- [ ] **Step 4: Add both to standalone acceptance**

Add `"zzwrite"` and `"zzwriterest"` to `FIXTURES` in `scripts/standalone-acceptance.ts`.

- [ ] **Step 5: Run everything**

```bash
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
bun run diff:golden --nimbus-root C:/gitrep/Nimbus    # 11/11
bun run standalone-acceptance --registry              # 40 checks across 4 fixtures
```

Confirm zero `cnc-*` directories remain in `%TEMP%`.

- [ ] **Step 6: Prove the snapshot test is not decorative**

Change one character in a checked-in snapshot file, run `bun test test/golden/snapshots.test.ts`, confirm it FAILS naming that file, then restore and confirm it passes. Paste both outcomes into the commit message.

- [ ] **Step 7: Commit**

```bash
git add fixtures/ test/ scripts/
git commit -m "test: write fixtures for both emission styles"
```

---

## Task 9: `[Nimbus]` accept `entrypoint` as a fallback for `entry`

**Files:**
- Modify: `C:\gitrep\Nimbus\packages\gateway\src\extensions\manifest.ts:168-169`
- Test: the existing extension-manifest test file in that package

**This task is in the AGPL monorepo, on its own branch and PR.** It is independent of Tasks 1–8 and may run in parallel.

- [ ] **Step 1: Write the failing test**

A manifest declaring `entrypoint: "dist/server.js"` and no `entry` must parse with `entry === "dist/server.js"`. A manifest declaring both must prefer `entry`.

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — `entry` is `undefined`, so consumers fall back to `dist/index.js`.

- [ ] **Step 3: Implement**

```ts
  // All 94 mcp-connectors and `nimbus scaffold extension` declare `entrypoint`; this parser
  // read only `entry`, so every one of them fell back to "dist/index.js" while building
  // dist/server.js — an install recorded an empty entry hash and verification then failed
  // with "entry file missing". `entry` still wins where both are present.
  const entryRaw = typeof o["entry"] === "string" ? o["entry"] : o["entrypoint"];
  const entry = typeof entryRaw === "string" ? entryRaw.trim().replaceAll("\\", "/") : undefined;
```

- [ ] **Step 4: Verify nothing else moved**

```bash
bun run typecheck
bun test packages/gateway/src/extensions/
```

71 tests pin the `dist/index.js` default; all must still pass, because the default only applies when neither key is present.

- [ ] **Step 5: Commit and open the PR**

```bash
git commit -m "fix(extensions): accept entrypoint as a fallback for entry"
```

---

## Task 10: Gateway wiring (opt-in)

**Files:**
- Create: `src/emit/wiring.ts`, `test/emit/wiring.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write the failing test**

`emitWiring(spec)` returns exactly two files: `<name>-sync.ts` containing `createXSyncable` and the spec's list-tool id, and `<name>-mapping.ts` whose body **throws** with a message naming what must be implemented. Assert the mapping stub throws when called, so an unfilled stub cannot be mistaken for a working mapping.

- [ ] **Step 2: Run to verify it fails** — module missing.

- [ ] **Step 3: Implement `emitWiring`**

The sync file follows the corpus shape: `createXSyncable(): Syncable` with `serviceId`, `defaultIntervalMs`, and a `sync()` that calls `listConnectorItems(ctx, SERVICE_ID, LIST_TOOL_ID)` and upserts via the mapping function.

- [ ] **Step 4: Add the CLI flag**

`--gateway-wiring <nimbus-root>` writes the two files under `<nimbus-root>/packages/gateway/src/connectors/` and prints the exact import and `syncScheduler.register(...)` lines to add to `platform/assemble-sync-registrations.ts`. **The generator does not edit that file** — it has 93 entries, lives in another repository under another licence, and a silent bad patch there is worse than a two-line paste.

- [ ] **Step 5: Run every gate**

```bash
bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/
bun run diff:golden --nimbus-root C:/gitrep/Nimbus   # 11/11, wiring is opt-in and off
```

- [ ] **Step 6: Commit**

```bash
git add src/emit/wiring.ts src/cli.ts test/emit/wiring.test.ts
git commit -m "feat(cli): opt-in Gateway wiring output"
```

---

## Task 11: Documentation and release

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-07-31-create-nimbus-connector-stage-c-design.md`

- [ ] **Step 1: Document the new fields** — `method`, `effect`, `body`, `client-credentials`, `--gateway-wiring`, and that `impl: "get"` is a deprecated alias.
- [ ] **Step 2: State the rest-kit advantage** — rest-kit gets writes through `buildInit` at no cost; hand-rolled needs a second emitted helper. Recommend rest-kit for new write connectors.
- [ ] **Step 3: Record the acceptance results** in the design doc, each with the command run and the observed output. If a criterion is only partly met, say so plainly.
- [ ] **Step 4: Run the full gate set** and paste real output into the commit body:

```bash
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run acceptance C:/gitrep/Nimbus
bun run standalone-acceptance --registry
bun run standalone-acceptance C:/gitrep/nimbus-sdk
```

Afterwards confirm zero `cnc-*` directories remain in `%TEMP%`, and that `C:\gitrep\Nimbus` and `C:\gitrep\nimbus-sdk` have clean working trees — the acceptance scripts write into repositories this project does not own.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/
git commit -m "feat: document Stage C write support and record acceptance results

feat: rather than docs: deliberately — the write path, client_credentials and
--gateway-wiring are user-visible additions, so release-please should cut a
minor release once this lands."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §3.1 tool fields | 1 |
| §3.2 validation | 1, 6 |
| §3.3 `hitlRequired` | 2 |
| §4.1 conditional write helper | 4 |
| §4.2 rest-kit `buildInit` | 5 |
| §4.3 hand-rolled second helper | 4 |
| §4.4 bodies | 3 |
| §4.5 `client-credentials` | 6 |
| §5.1 monorepo harness unchanged | 1–10 (gate in every task) |
| §5.2 snapshots | 7 |
| §5.3 standalone acceptance | 8 |
| §6 Gateway wiring | 10 |
| §7 sequencing | task order; Task 9 parallel |
| §1.6 `entrypoint` defect | 9 |

No spec section is unimplemented.

**Deliberate deviations from the spec:**

- The spec names the write helper generically; this plan fixes it as `${fetchHelper.local}Send` so Tasks 4 and 8 cannot disagree.
- `renderWriteHelper` returns `undefined` for rest-kit as well as for read-only specs. The spec implies this; stating it prevents an implementer emitting a helper rest-kit never calls.

**Type consistency:** `renderBodyExpr(tool, param)` is defined in Task 3 and consumed under that exact name in Tasks 4 and 5. `renderWriteHelper(spec)` is defined in Task 4 and used in Task 4 Step 5. `loadSnapshot`/`compareSnapshot`/`SnapshotDiff` are defined in Task 7 and used in Tasks 7 and 8.
