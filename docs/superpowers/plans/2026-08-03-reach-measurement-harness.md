# Corpus Reach Measurement Harness — Implementation Plan

> **Post-execution note:** This plan's reference listings (code excerpts, task briefs) were
> found to contain defects during execution and the final fix wave — recognizers that claimed a
> function body without verifying its interior, an untested `measure()`, a baseline keyed on the
> wrong git object, among others. `scripts/_lib/derive/` (and the rest of `scripts/_lib/`) as
> committed is the authority on current behaviour, not the snippets below. The ledger that
> records what was fixed and why is gitignored and does not ship with this repository.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `bun run reach`, which derives a spec from each connector in a Nimbus checkout, regenerates it, byte-compares the result, and reports how far it got plus a histogram of what blocked the rest.

**Architecture:** A pure deriver (`scripts/_lib/derive/`) turns connector source into a raw spec object, under a totality rule: every statement in the real `src/server.ts` must be claimed by a matcher or the connector is blocked. A pure reporting layer (`scripts/_lib/reach.ts`) tiers each connector and formats the output. Thin `scripts/reach*.ts` shells do the filesystem and git I/O that cannot run without a monorepo checkout.

**Tech Stack:** Bun, TypeScript, `@babel/parser` (new devDependency), Biome via the existing in-process `@biomejs/js-api`, `bun:test`.

**Spec:** [`docs/superpowers/specs/2026-08-03-from-connector-reach-design.md`](../specs/2026-08-03-from-connector-reach-design.md)

## Scope: this is plan 1 of 2

The spec describes recognizers for every emitter path. This plan implements the **hand-rolled
style** family end to end — parser, claims, blockers, manifest, env, fetch helper, args, path
templates, simple tools, tiering, baseline, both shells, docs.

That is a complete, working, honest instrument on its own: `bun run reach` produces real tier
counts and a real histogram. Connectors in the other two styles land in `blocked` with accurate
buckets (`const-call:makeRestToolRegistrar`, `call:runReadOnlyMcpConnector`) rather than being
miscounted, because the totality rule cannot over-report.

**Plan 2, not written yet,** adds the `rest-kit` and `read-only-kit` frames, search tools,
`query`, and `body` recognizers. Do not start it until plan 1's round-trip test is green — every
recognizer it adds is written against the claim machinery this plan builds.

## Global Constraints

Every task's requirements implicitly include these.

- **Bun-only.** No Node, npm or pnpm path. Tests import `bun:test`.
- **Never commit on `main`.** Work on a branch.
- **Conventional Commits.** `feat:` bumps the minor, `fix:` the patch. These drive release-please.
- **No connector source, and no `shared/` source, may be copied into this repository** — not into `src/`, not into `test/`, not into `fixtures/`. Every test input in this plan is either hand-written here or produced by this repository's own emitter. This is a licensing constraint, not a style preference.
- **Per-file coverage floors**, enforced by `bunfig.toml`: `lines = 0.78`, `functions = 0.81`. Bun applies these **per file**, and a file enters the report the moment a test imports it. Every module this plan creates under `scripts/_lib/` must clear both floors on its own.
- **Biome must pass:** `bunx biome check src/ test/ scripts/`.
- **The byte-safety invariant.** `newrelic`, `datadog`, `grafana` and `sentry` reproduce 6/6 files byte-for-byte. This plan adds no emitter path and must not change `src/`. If any task finds itself editing `src/emit/`, stop — that is a different change.
- **`bun run reach` must never run in CI.** It needs the AGPL monorepo. Do not add a CI job for it, and do not add one that skips when the root is absent.

## Refinement of the spec

The spec writes `deriveSpec(files) -> Derivation` with `spec: ConnectorSpec`. This plan narrows
that: **`deriveSpec` returns a raw spec object (`Record<string, unknown>`), not a parsed
`ConnectorSpec`.** The spec's own tier table puts "`parseSpec` **and** `validateSpec` accept"
inside the `emits` tier, so validation is a tier boundary the reporting layer crosses, not
something the deriver does. Keeping `parseSpec` out of the deriver is also what lets a derived
spec that trips `RESERVED_IDENTIFIERS` be *counted* rather than *thrown*.

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/_lib/derive/ast.ts` | Local structural node types + the `parseModule` wrapper |
| `scripts/_lib/derive/claims.ts` | `ClaimSet`: byte-range claims, containment coverage |
| `scripts/_lib/derive/blockers.ts` | `blockerFor(node, source)` — the bucket-naming policy |
| `scripts/_lib/derive/manifest.ts` | `nimbus.extension.json` → spec fields |
| `scripts/_lib/derive/server/index.ts` | The hand-rolled frame (imports, `mcp`, `reg`, transport, connect) |
| `scripts/_lib/derive/server/env.ts` | Env accessor functions → `spec.env` entries |
| `scripts/_lib/derive/server/fetch-helper.ts` | The read helper → `spec.fetchHelper` + `serviceLabel` |
| `scripts/_lib/derive/server/args.ts` | `z.object({…})` → a tool's `args` |
| `scripts/_lib/derive/server/path-template.ts` | A fetch call's path argument → the path DSL string |
| `scripts/_lib/derive/server/tools-hand.ts` | `reg(…)` calls → `spec.tools` entries |
| `scripts/_lib/derive/index.ts` | Composes the recognizers, applies the totality rule |
| `scripts/_lib/reach.ts` | Tiering, verdict lines, histogram, summary |
| `scripts/_lib/reach-baseline.ts` | Baseline shape, comparison, refusals |
| `scripts/reach.ts` | Shell: args, resolve root, read files, print |
| `scripts/reach-baseline.ts` | Shell: writes `fixtures/reach-baseline.json` |

Recognizer modules under `derive/server/` are named to match `src/emit/server/` one-to-one. That
mapping is the point: a future pull request that adds an emitter path without touching its
recognizer is visibly incomplete.

## Shared types

Defined in Task 1, used by every later task. Reproduced here so tasks can be read out of order.

```ts
// scripts/_lib/derive/ast.ts
export type AstNode = {
  type: string;
  start: number | null;
  end: number | null;
  loc?: { start: { line: number } };
  [key: string]: unknown;
};

// scripts/_lib/derive/blockers.ts
export type Blocker = { kind: string; detail: string; line: number };

// scripts/_lib/derive/index.ts
export type SourceFiles = { server: string; manifest: string };
export type Derivation =
  | { ok: true; spec: Record<string, unknown> }
  | { ok: false; blockers: Blocker[] };

// scripts/_lib/reach.ts
export type Tier = "blocked" | "emits" | "server-identical" | "all-identical";
```

---

### Task 1: The parser wrapper and the claim set

**Files:**
- Modify: `package.json` (devDependencies)
- Create: `scripts/_lib/derive/ast.ts`
- Create: `scripts/_lib/derive/claims.ts`
- Test: `test/scripts/derive-claims.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type AstNode`; `parseModule(source: string): AstNode[]`; `type Claim = { start: number; end: number; by: string }`; `type ClaimSet`; `createClaimSet(): ClaimSet` with methods `claim(nodes: AstNode | readonly AstNode[], by: string): void`, `covers(node: AstNode): boolean`, `unclaimed(nodes: readonly AstNode[]): AstNode[]`.

- [ ] **Step 1: Add the parser dependency**

```bash
bun add -d @babel/parser @babel/types
```

Both are MIT and pure JavaScript. `@babel/types` is needed even though no runtime code imports
it: `@babel/parser`'s own type declarations reference it, and `bunx tsc --noEmit` fails without
it. Neither reaches the published tarball — `package.json`'s `files` is `["src", "README.md"]`.

- [ ] **Step 2: Write the failing test**

Create `test/scripts/derive-claims.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";

const SOURCE = [
  'import { z } from "zod";',
  "function apiKey(): string {",
  '  const k = process.env["A"]?.trim();',
  "  return k;",
  "}",
  "const mcp = 1;",
].join("\n");

describe("parseModule", () => {
  it("parses TypeScript annotations that the base parser rejects", () => {
    const statements = parseModule(SOURCE);
    expect(statements.map((s) => s.type)).toEqual([
      "ImportDeclaration",
      "FunctionDeclaration",
      "VariableDeclaration",
    ]);
  });

  it("throws on source it cannot parse, rather than returning a partial program", () => {
    expect(() => parseModule("const = ;")).toThrow();
  });
});

describe("createClaimSet", () => {
  it("reports a claimed statement as covered and an unclaimed one as not", () => {
    const statements = parseModule(SOURCE);
    const claims = createClaimSet();
    claims.claim(statements[0]!, "frame");

    expect(claims.covers(statements[0]!)).toBe(true);
    expect(claims.covers(statements[1]!)).toBe(false);
    expect(claims.unclaimed(statements).map((s) => s.type)).toEqual([
      "FunctionDeclaration",
      "VariableDeclaration",
    ]);
  });

  it("claims several statements in one call, for the multi-statement constructs the emitter writes", () => {
    const statements = parseModule(SOURCE);
    const claims = createClaimSet();
    claims.claim([statements[1]!, statements[2]!], "env");

    expect(claims.unclaimed(statements).map((s) => s.type)).toEqual(["ImportDeclaration"]);
  });

  it("covers a node nested inside a claimed range without a separate claim", () => {
    const statements = parseModule(SOURCE);
    const fn = statements[1]!;
    const body = (fn["body"] as { body: AstNodeLike[] }).body;
    const claims = createClaimSet();
    claims.claim(fn, "env");

    expect(claims.covers(body[0]!)).toBe(true);
  });

  it("refuses a node with no source range instead of silently claiming nothing", () => {
    const claims = createClaimSet();
    expect(() => claims.claim({ type: "Fake", start: null, end: null }, "x")).toThrow(
      /no source range/,
    );
  });
});

type AstNodeLike = { type: string; start: number | null; end: number | null };
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `bun test test/scripts/derive-claims.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/_lib/derive/ast.ts'`.

- [ ] **Step 4: Write `ast.ts`**

```ts
/**
 * The parser boundary. Everything downstream reads plain structural node types rather than
 * Babel's, so a matcher can be unit-tested against a hand-written object and the parser stays
 * replaceable.
 */
import { parse } from "@babel/parser";

export type AstNode = {
  type: string;
  start: number | null;
  end: number | null;
  loc?: { start: { line: number } };
  [key: string]: unknown;
};

/**
 * `plugins: ["typescript"]` is required, not optional: connector source carries type
 * annotations and generics that the base parser rejects outright. No `jsx` or `decorators` —
 * neither appears in the corpus, and a plugin list longer than the syntax in play widens what
 * parses without widening what is recognized.
 */
export function parseModule(source: string): AstNode[] {
  const file = parse(source, { sourceType: "module", plugins: ["typescript"] });
  return file.program.body as unknown as AstNode[];
}
```

- [ ] **Step 5: Write `claims.ts`**

```ts
import type { AstNode } from "./ast.ts";

export type Claim = { start: number; end: number; by: string };

export type ClaimSet = {
  claim: (nodes: AstNode | readonly AstNode[], by: string) => void;
  covers: (node: AstNode) => boolean;
  unclaimed: (nodes: readonly AstNode[]) => AstNode[];
  claims: () => readonly Claim[];
};

function span(node: AstNode): { start: number; end: number } {
  if (node.start === null || node.end === null) {
    throw new Error(
      `A ${node.type} node has no source range, so it can be neither claimed nor checked. ` +
        "This is a programming error in the parser wrapper, not a property of the input.",
    );
  }
  return { start: node.start, end: node.end };
}

/**
 * Claims are byte ranges rather than statement indices, and coverage is containment.
 *
 * Both are load-bearing. The emitter writes multi-statement constructs — the hoisted argument
 * consts that precede a handler, the query branch's URL trio, the client-credentials token
 * bindings — so a matcher must be able to claim several statements at once. And containment
 * means a statement nested inside a claimed arrow-function body needs no separate claim, which
 * keeps the walker from having to know which list a node came from.
 */
export function createClaimSet(): ClaimSet {
  const all: Claim[] = [];

  const covers = (node: AstNode): boolean => {
    const { start, end } = span(node);
    return all.some((c) => c.start <= start && end <= c.end);
  };

  return {
    claim(nodes, by) {
      const list = Array.isArray(nodes) ? nodes : [nodes as AstNode];
      for (const n of list) {
        const { start, end } = span(n);
        all.push({ start, end, by });
      }
    },
    covers,
    unclaimed: (nodes) => nodes.filter((n) => !covers(n)),
    claims: () => all,
  };
}
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `bun test test/scripts/derive-claims.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Verify the repo still typechecks and lints**

Run: `bunx tsc --noEmit && bunx biome check src/ test/ scripts/`
Expected: both clean. If `tsc` complains about missing `@babel/types`, Step 1 was skipped.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock scripts/_lib/derive/ast.ts scripts/_lib/derive/claims.ts test/scripts/derive-claims.test.ts
git commit -m "feat(reach): parse connector source and track claims by byte range"
```

---

### Task 2: Blocker naming

**Files:**
- Create: `scripts/_lib/derive/blockers.ts`
- Test: `test/scripts/derive-blockers.test.ts`

**Interfaces:**
- Consumes: `AstNode` from `./ast.ts`.
- Produces: `type Blocker = { kind: string; detail: string; line: number }`; `blockerFor(node: AstNode, source: string): Blocker`.

The `kind` string is the histogram bucket. It is derived from the unclaimed statement's syntactic
head, so buckets are discovered rather than enumerated: nothing needs to know in advance that
"multi-file" is a category — it shows up as `import-from:./tools.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/derive-blockers.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { blockerFor } from "../../scripts/_lib/derive/blockers.ts";

function first(source: string) {
  return blockerFor(parseModule(source)[0]!, source);
}

describe("blockerFor", () => {
  it("names an import by its source, so a multi-file connector is its own bucket", () => {
    expect(first('import { listTools } from "./tools.ts";').kind).toBe("import-from:./tools.ts");
  });

  it("names a bare call by callee", () => {
    expect(first("runReadOnlyMcpConnector(cfg);").kind).toBe("call:runReadOnlyMcpConnector");
  });

  it("names a method call by property, not by receiver", () => {
    expect(first("u.searchParams.append(k, v);").kind).toBe("method-call:.append");
  });

  it("names a const initialised by a call, which is how the rest-kit registrar appears", () => {
    expect(first("const reg = makeRestToolRegistrar(mcp);").kind).toBe(
      "const-call:makeRestToolRegistrar",
    );
  });

  it("names a function declaration by its identifier", () => {
    expect(first("function tagNames(row) { return []; }").kind).toBe("function:tagNames");
  });

  it("falls back to the node type when nothing more specific applies", () => {
    expect(first("for (const x of xs) { g(x); }").kind).toBe("statement:ForOfStatement");
  });

  it("records the source text and line so a near-miss is actionable", () => {
    const b = first("const n = p.pageSize ?? 50;");
    expect(b.detail).toBe("const n = p.pageSize ?? 50;");
    expect(b.line).toBe(1);
  });

  it("collapses whitespace and truncates a long statement", () => {
    const source = `const x = {\n  a: 1,\n${"  // ".repeat(1)}\n};`;
    expect(first(source).detail).not.toContain("\n");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/scripts/derive-blockers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `blockers.ts`**

```ts
import type { AstNode } from "./ast.ts";

export type Blocker = { kind: string; detail: string; line: number };

const MAX_DETAIL = 100;

function calleeKind(callee: AstNode, prefix: string): string | undefined {
  if (callee.type === "Identifier") return `${prefix}:${String(callee["name"])}`;
  if (callee.type === "MemberExpression") {
    const property = callee["property"] as AstNode | undefined;
    if (property?.type === "Identifier") return `method-call:.${String(property["name"])}`;
  }
  return undefined;
}

function kindOf(node: AstNode): string {
  if (node.type === "ImportDeclaration") {
    const source = node["source"] as AstNode | undefined;
    return `import-from:${String(source?.["value"] ?? "?")}`;
  }
  if (node.type === "ExpressionStatement") {
    const expression = node["expression"] as AstNode | undefined;
    if (expression?.type === "CallExpression") {
      const kind = calleeKind(expression["callee"] as AstNode, "call");
      if (kind !== undefined) return kind;
    }
  }
  if (node.type === "VariableDeclaration") {
    const declarations = node["declarations"] as AstNode[] | undefined;
    const init = declarations?.[0]?.["init"] as AstNode | undefined;
    if (init?.type === "CallExpression") {
      const kind = calleeKind(init["callee"] as AstNode, "const-call");
      if (kind !== undefined) return kind;
    }
  }
  if (node.type === "FunctionDeclaration") {
    const id = node["id"] as AstNode | undefined;
    if (id?.type === "Identifier") return `function:${String(id["name"])}`;
  }
  return `statement:${node.type}`;
}

/**
 * The histogram bucket for one unclaimed statement.
 *
 * `kind` is deliberately coarse and `detail` deliberately specific: the bucket is what gets
 * counted and compared across connectors, while the detail is what makes a near-miss
 * actionable — an inlined `?? 50` reads as its own line rather than disappearing into a pile
 * labelled "unknown".
 */
export function blockerFor(node: AstNode, source: string): Blocker {
  const text = node.start === null || node.end === null ? "" : source.slice(node.start, node.end);
  const collapsed = text.replaceAll(/\s+/g, " ").trim();
  return {
    kind: kindOf(node),
    detail: collapsed.length > MAX_DETAIL ? `${collapsed.slice(0, MAX_DETAIL)}…` : collapsed,
    line: node.loc?.start.line ?? 0,
  };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun test test/scripts/derive-blockers.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/_lib/derive/blockers.ts test/scripts/derive-blockers.test.ts
git commit -m "feat(reach): name blocker buckets from the unclaimed statement's head"
```

---

### Task 3: The manifest recognizer

**Files:**
- Create: `scripts/_lib/derive/manifest.ts`
- Test: `test/scripts/derive-manifest.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `deriveManifest(json: string): ManifestFields` where
  `type ManifestFields = { id?: string; displayName: string; description: string; network: string[]; filesystem?: { read: string[]; write: string[] }; syncInterval: number; minNimbusVersion: string }`.

`src/emit/manifest.ts` writes exactly these keys, so this recognizer is a straight inversion. Two
manifest keys are deliberately **not** recovered: `hitlRequired` is computed from tool effects
rather than declared, and `version`/`author`/`entrypoint`/`runtime` are constants the emitter
hardcodes.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/derive-manifest.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { deriveManifest } from "../../scripts/_lib/derive/manifest.ts";

const MANIFEST = JSON.stringify({
  id: "newrelic",
  displayName: "New Relic",
  version: "0.1.0",
  description: "Query New Relic.",
  author: "Nimbus",
  entrypoint: "dist/server.js",
  runtime: "bun",
  permissions: { network: ["api.newrelic.com"] },
  hitlRequired: [],
  syncInterval: 300,
  minNimbusVersion: "0.2.0",
});

describe("deriveManifest", () => {
  it("recovers the fields the emitter writes from the spec", () => {
    expect(deriveManifest(MANIFEST)).toEqual({
      id: "newrelic",
      displayName: "New Relic",
      description: "Query New Relic.",
      network: ["api.newrelic.com"],
      syncInterval: 300,
      minNimbusVersion: "0.2.0",
    });
  });

  it("recovers filesystem when present, since its absence is meaningful", () => {
    const withFs = JSON.stringify({
      ...JSON.parse(MANIFEST),
      permissions: { network: [], filesystem: { read: ["/tmp"], write: [] } },
    });
    expect(deriveManifest(withFs).filesystem).toEqual({ read: ["/tmp"], write: [] });
  });

  it("throws on a manifest missing a required key rather than inventing one", () => {
    expect(() => deriveManifest('{"displayName":"X"}')).toThrow(/description/);
  });

  it("throws on malformed JSON", () => {
    expect(() => deriveManifest("{not json")).toThrow();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/scripts/derive-manifest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `manifest.ts`**

```ts
export type ManifestFields = {
  id?: string;
  displayName: string;
  description: string;
  network: string[];
  filesystem?: { read: string[]; write: string[] };
  syncInterval: number;
  minNimbusVersion: string;
};

function req<T>(value: T | undefined, key: string): T {
  if (value === undefined) {
    throw new Error(`nimbus.extension.json has no "${key}" — it is not a connector manifest.`);
  }
  return value;
}

/**
 * The inverse of src/emit/manifest.ts, key for key.
 *
 * `hitlRequired` is deliberately not recovered: the emitter computes it from tool effects
 * rather than reading it, so a derived spec that carried it would be carrying a field the
 * emitter ignores. `version`, `author`, `entrypoint` and `runtime` are emitter constants for
 * the same reason.
 */
export function deriveManifest(json: string): ManifestFields {
  const m = JSON.parse(json) as Record<string, unknown>;
  const permissions = req(m["permissions"] as Record<string, unknown> | undefined, "permissions");
  const filesystem = permissions["filesystem"] as ManifestFields["filesystem"];
  return {
    ...(m["id"] === undefined ? {} : { id: String(m["id"]) }),
    displayName: req(m["displayName"] as string | undefined, "displayName"),
    description: req(m["description"] as string | undefined, "description"),
    network: req(permissions["network"] as string[] | undefined, "permissions.network"),
    ...(filesystem === undefined ? {} : { filesystem }),
    syncInterval: req(m["syncInterval"] as number | undefined, "syncInterval"),
    minNimbusVersion: req(m["minNimbusVersion"] as string | undefined, "minNimbusVersion"),
  };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun test test/scripts/derive-manifest.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/_lib/derive/manifest.ts test/scripts/derive-manifest.test.ts
git commit -m "feat(reach): recover spec fields from nimbus.extension.json"
```

---

### Task 4: The hand-rolled frame recognizer

**Files:**
- Create: `scripts/_lib/derive/server/index.ts`
- Test: `test/scripts/derive-frame.test.ts`

**Interfaces:**
- Consumes: `AstNode`, `ClaimSet`.
- Produces: `recognizeFrame(statements: readonly AstNode[], claims: ClaimSet): FrameFields | undefined` where `type FrameFields = { name: string }`. Returns `undefined` when the module is not the hand-rolled frame, claiming nothing.

The hand-rolled frame is eight statements: four imports, `const mcp = new McpServer({ name, version })`,
`const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp))`,
`const transport = new StdioServerTransport()`, and `await mcp.connect(transport)`. The connector's
`spec.name` is the `nimbus-` prefix stripped from the McpServer name.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/derive-frame.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";
import { recognizeFrame } from "../../scripts/_lib/derive/server/index.ts";

const FRAME = [
  'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
  'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
  'import { z } from "zod";',
  'import { createRegisterSimpleTool, createZodToolRegistrar, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";',
  'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
  "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
  "const transport = new StdioServerTransport();",
  "await mcp.connect(transport);",
].join("\n");

describe("recognizeFrame", () => {
  it("recovers the connector name and claims every frame statement", () => {
    const statements = parseModule(FRAME);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toEqual({ name: "newrelic" });
    expect(claims.unclaimed(statements)).toEqual([]);
  });

  it("leaves a non-frame statement unclaimed", () => {
    const source = `${FRAME}\nfunction extra() {}`;
    const statements = parseModule(source);
    const claims = createClaimSet();

    recognizeFrame(statements, claims);
    expect(claims.unclaimed(statements).map((s) => s.type)).toEqual(["FunctionDeclaration"]);
  });

  it("returns undefined and claims nothing for a read-only-kit module", () => {
    const statements = parseModule('import { runReadOnlyMcpConnector } from "../../shared/x.ts";');
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/scripts/derive-frame.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/index.ts`**

```ts
import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";

export type FrameFields = { name: string };

const FRAME_IMPORTS = new Set([
  "@modelcontextprotocol/sdk/server/mcp.js",
  "@modelcontextprotocol/sdk/server/stdio.js",
  "zod",
]);

function importSource(node: AstNode): string | undefined {
  if (node.type !== "ImportDeclaration") return undefined;
  return String((node["source"] as AstNode | undefined)?.["value"] ?? "");
}

function isFrameImport(node: AstNode): boolean {
  const source = importSource(node);
  if (source === undefined) return false;
  return FRAME_IMPORTS.has(source) || source.endsWith("/mcp-tool-kit.ts");
}

/** `new McpServer({ name: "nimbus-<name>", … })` -> `<name>`. */
function mcpServerName(node: AstNode): string | undefined {
  if (node.type !== "VariableDeclaration") return undefined;
  const init = (node["declarations"] as AstNode[])[0]?.["init"] as AstNode | undefined;
  if (init?.type !== "NewExpression") return undefined;
  const callee = init["callee"] as AstNode;
  if (callee.type !== "Identifier" || callee["name"] !== "McpServer") return undefined;
  const arg = (init["arguments"] as AstNode[])[0];
  const properties = (arg?.["properties"] as AstNode[] | undefined) ?? [];
  for (const p of properties) {
    const key = p["key"] as AstNode | undefined;
    const value = p["value"] as AstNode | undefined;
    if (key?.["name"] === "name" && typeof value?.["value"] === "string") {
      const full = value["value"];
      return full.startsWith("nimbus-") ? full.slice("nimbus-".length) : full;
    }
  }
  return undefined;
}

function isConstFrom(node: AstNode, callee: string): boolean {
  if (node.type !== "VariableDeclaration") return false;
  const init = (node["declarations"] as AstNode[])[0]?.["init"] as AstNode | undefined;
  if (init?.type === "CallExpression") {
    return (init["callee"] as AstNode)["name"] === callee;
  }
  if (init?.type === "NewExpression") {
    return (init["callee"] as AstNode)["name"] === callee;
  }
  return false;
}

/** `await mcp.connect(transport);` */
function isConnect(node: AstNode): boolean {
  if (node.type !== "ExpressionStatement") return false;
  const await_ = node["expression"] as AstNode;
  if (await_.type !== "AwaitExpression") return false;
  const call = await_["argument"] as AstNode;
  if (call.type !== "CallExpression") return false;
  const callee = call["callee"] as AstNode;
  return callee.type === "MemberExpression" && (callee["property"] as AstNode)["name"] === "connect";
}

/**
 * The hand-rolled prologue and epilogue, as src/emit/server/index.ts writes them.
 *
 * Returns undefined and claims NOTHING when the module is not this frame — a partially claimed
 * module would leave the totality rule reporting blockers for statements a different style's
 * recognizer would have claimed, which reads as a spec-language gap when it is a
 * wrong-recognizer gap. All or nothing is what keeps the histogram honest.
 */
export function recognizeFrame(
  statements: readonly AstNode[],
  claims: ClaimSet,
): FrameFields | undefined {
  const name = statements.map(mcpServerName).find((n) => n !== undefined);
  if (name === undefined) return undefined;

  const frame = statements.filter(
    (s) =>
      isFrameImport(s) ||
      mcpServerName(s) !== undefined ||
      isConstFrom(s, "createZodToolRegistrar") ||
      isConstFrom(s, "StdioServerTransport") ||
      isConnect(s),
  );
  claims.claim(frame, "frame");
  return { name };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun test test/scripts/derive-frame.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/_lib/derive/server/index.ts test/scripts/derive-frame.test.ts
git commit -m "feat(reach): recognize the hand-rolled server frame"
```

---

### Task 5: The env accessor recognizer

**Files:**
- Create: `scripts/_lib/derive/server/env.ts`
- Test: `test/scripts/derive-env.test.ts`

**Interfaces:**
- Consumes: `AstNode`, `ClaimSet`.
- Produces: `recognizeEnv(statements: readonly AstNode[], claims: ClaimSet): EnvEntry[]` where `type EnvEntry = { vars: string[]; local: string; bindings: string[]; required: boolean }`.

`src/emit/server/env.ts` writes the binding identifier from `e.bindings?.[i] ?? camel(e.vars[i])`
and emits the `if (… === undefined || … === "") throw` guard only when `e.required` is true. Both
fields are therefore recoverable from the accessor body — which is what makes an env entry
round-trip at all.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/derive-env.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";
import { recognizeEnv } from "../../scripts/_lib/derive/server/env.ts";

const REQUIRED = [
  "function apiKey(): string {",
  '  const k = process.env["NEW_RELIC_API_KEY"]?.trim();',
  '  if (k === undefined || k === "") {',
  '    throw new Error("NEW_RELIC_API_KEY is not set");',
  "  }",
  "  return k;",
  "}",
].join("\n");

const OPTIONAL = [
  "function region(): string {",
  '  const r = process.env["REGION"]?.trim();',
  "  return r;",
  "}",
].join("\n");

function run(source: string) {
  const statements = parseModule(source);
  const claims = createClaimSet();
  const entries = recognizeEnv(statements, claims);
  return { entries, unclaimed: claims.unclaimed(statements) };
}

describe("recognizeEnv", () => {
  it("recovers the var, the local, the binding name and required from the guard", () => {
    const { entries, unclaimed } = run(REQUIRED);
    expect(entries).toEqual([
      { vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true },
    ]);
    expect(unclaimed).toEqual([]);
  });

  it("reads an accessor with no guard as required: false", () => {
    expect(run(OPTIONAL).entries[0]).toEqual({
      vars: ["REGION"],
      local: "region",
      bindings: ["r"],
      required: false,
    });
  });

  it("leaves an unrelated function unclaimed rather than guessing", () => {
    const { entries, unclaimed } = run("function tagNames(row) { return []; }");
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });

  it("does not claim a multi-var accessor, which this recognizer does not model", () => {
    const source = [
      "function creds(): string {",
      '  const a = process.env["A"]?.trim();',
      '  const b = process.env["B"]?.trim();',
      "  return a + b;",
      "}",
    ].join("\n");
    const { entries, unclaimed } = run(source);
    expect(entries).toEqual([]);
    expect(unclaimed).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/scripts/derive-env.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/env.ts`**

```ts
import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";

export type EnvEntry = {
  vars: string[];
  local: string;
  bindings: string[];
  required: boolean;
};

/** `process.env["VAR"]?.trim()` -> `VAR`. */
function envVarRead(init: AstNode | undefined): string | undefined {
  if (init?.type !== "CallExpression") return undefined;
  const callee = init["callee"] as AstNode;
  if (callee.type !== "OptionalMemberExpression" && callee.type !== "MemberExpression") {
    return undefined;
  }
  if ((callee["property"] as AstNode)["name"] !== "trim") return undefined;
  const member = callee["object"] as AstNode;
  if (member.type !== "MemberExpression") return undefined;
  const object = member["object"] as AstNode;
  if (object.type !== "MemberExpression") return undefined;
  if ((object["object"] as AstNode)["name"] !== "process") return undefined;
  if ((object["property"] as AstNode)["name"] !== "env") return undefined;
  const key = member["property"] as AstNode;
  return typeof key["value"] === "string" ? key["value"] : undefined;
}

function bodyStatements(fn: AstNode): AstNode[] {
  return ((fn["body"] as AstNode | undefined)?.["body"] as AstNode[] | undefined) ?? [];
}

/**
 * One env accessor, as src/emit/server/env.ts writes it:
 *
 *   function <local>(): string {
 *     const <binding> = process.env["<VAR>"]?.trim();
 *     [if (<binding> === undefined || <binding> === "") { throw … }]   // only when required
 *     return <binding>;
 *   }
 *
 * The guard's presence IS `required`, and the binding identifier IS `bindings[0]` — the emitter
 * writes `e.bindings?.[i] ?? camel(e.vars[i])`, so a spec that omitted the binding would emit a
 * camelCased name instead of whatever is on the page. Recovering the identifier verbatim is what
 * makes the round trip byte-exact rather than merely equivalent.
 */
function recognizeOne(fn: AstNode): EnvEntry | undefined {
  if (fn.type !== "FunctionDeclaration") return undefined;
  const statements = bodyStatements(fn);
  const first = statements[0];
  if (first?.type !== "VariableDeclaration") return undefined;

  const declarator = (first["declarations"] as AstNode[])[0];
  const binding = (declarator?.["id"] as AstNode | undefined)?.["name"];
  const variable = envVarRead(declarator?.["init"] as AstNode | undefined);
  if (typeof binding !== "string" || variable === undefined) return undefined;

  // Exactly two shapes are modelled: read + return, and read + guard + return. Anything else
  // is left unclaimed rather than approximated — a multi-var accessor lands here, and lands in
  // the histogram as function:<name>, which is the honest answer.
  const guarded = statements.length === 3 && statements[1]?.type === "IfStatement";
  const plain = statements.length === 2;
  if (!guarded && !plain) return undefined;
  if (statements.at(-1)?.type !== "ReturnStatement") return undefined;

  return { vars: [variable], local: String(fn["id"] ? (fn["id"] as AstNode)["name"] : ""), bindings: [binding], required: guarded };
}

export function recognizeEnv(statements: readonly AstNode[], claims: ClaimSet): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const s of statements) {
    const entry = recognizeOne(s);
    if (entry === undefined) continue;
    claims.claim(s, "env");
    entries.push(entry);
  }
  return entries;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun test test/scripts/derive-env.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/_lib/derive/server/env.ts test/scripts/derive-env.test.ts
git commit -m "feat(reach): recognize env accessors, including bindings and required"
```

---

### Task 6: The fetch-helper recognizer

**Files:**
- Create: `scripts/_lib/derive/server/fetch-helper.ts`
- Test: `test/scripts/derive-fetch-helper.test.ts`

**Interfaces:**
- Consumes: `AstNode`, `ClaimSet`.
- Produces: `recognizeFetchHelper(statements: readonly AstNode[], claims: ClaimSet): FetchHelperFields | undefined` where `type FetchHelperFields = { local: string; base: string; serviceLabel: string; inlineHeaders: Record<string, string> }`.

An inline header value that is a bare accessor call (`apiKey()`) is recovered as `"${env.apiKey}"`;
a string literal is recovered verbatim. That inversion mirrors `headerOption` in
`src/emit/server/fetch-helper.ts`, which emits an accessor call for a whole-value `${env.X}` and a
JSON literal otherwise.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/derive-fetch-helper.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";
import { recognizeFetchHelper } from "../../scripts/_lib/derive/server/fetch-helper.ts";

const HELPER = [
  "async function nrGet(path: string): Promise<unknown> {",
  "  const res = await fetch(`https://api.newrelic.com${path}`, {",
  '    headers: { "X-Api-Key": apiKey(), Accept: "application/json" },',
  "  });",
  "  const text = await res.text();",
  "  if (!res.ok) {",
  "    throw new Error(`New Relic ${String(res.status)}: ${text.slice(0, 400)}`);",
  "  }",
  "  return JSON.parse(text) as unknown;",
  "}",
].join("\n");

function run(source: string) {
  const statements = parseModule(source);
  const claims = createClaimSet();
  return { fields: recognizeFetchHelper(statements, claims), claims, statements };
}

describe("recognizeFetchHelper", () => {
  it("recovers the local, base, service label and inline headers", () => {
    const { fields, claims, statements } = run(HELPER);
    expect(fields).toEqual({
      local: "nrGet",
      base: "https://api.newrelic.com",
      serviceLabel: "New Relic",
      inlineHeaders: { "X-Api-Key": "${env.apiKey}", Accept: "application/json" },
    });
    expect(claims.unclaimed(statements)).toEqual([]);
  });

  it("returns undefined for a function that is not a fetch helper", () => {
    expect(run("async function g(): Promise<void> {}").fields).toBeUndefined();
  });

  it("claims nothing when it does not recognize the helper", () => {
    const { claims } = run("async function g(): Promise<void> {}");
    expect(claims.claims()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/scripts/derive-fetch-helper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/fetch-helper.ts`**

```ts
import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";

export type FetchHelperFields = {
  local: string;
  base: string;
  serviceLabel: string;
  inlineHeaders: Record<string, string>;
};

function walk(node: unknown, visit: (n: AstNode) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as AstNode;
  if (typeof n.type === "string") visit(n);
  for (const [key, value] of Object.entries(n)) {
    if (key === "loc") continue;
    walk(value, visit);
  }
}

function find(root: AstNode, predicate: (n: AstNode) => boolean): AstNode | undefined {
  let found: AstNode | undefined;
  walk(root, (n) => {
    if (found === undefined && predicate(n)) found = n;
  });
  return found;
}

/** The literal head of `` `<base>${path}` ``. */
function templateHead(node: AstNode): string | undefined {
  if (node.type !== "TemplateLiteral") return undefined;
  const first = (node["quasis"] as AstNode[])[0];
  const cooked = (first?.["value"] as { cooked?: string } | undefined)?.cooked;
  return cooked;
}

function headerValue(value: AstNode): string | undefined {
  if (typeof value["value"] === "string") return value["value"];
  if (value.type === "CallExpression") {
    const callee = value["callee"] as AstNode;
    if (callee.type === "Identifier") return `\${env.${String(callee["name"])}}`;
  }
  return undefined;
}

function inlineHeaders(fetchCall: AstNode): Record<string, string> | undefined {
  const options = (fetchCall["arguments"] as AstNode[])[1];
  const properties = (options?.["properties"] as AstNode[] | undefined) ?? [];
  const headers = properties.find((p) => (p["key"] as AstNode)["name"] === "headers");
  const entries = (headers?.["value"] as AstNode | undefined)?.["properties"] as
    | AstNode[]
    | undefined;
  if (entries === undefined) return undefined;

  const out: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry["key"] as AstNode;
    const name = typeof key["value"] === "string" ? key["value"] : String(key["name"] ?? "");
    const value = headerValue(entry["value"] as AstNode);
    if (name === "" || value === undefined) return undefined;
    out[name] = value;
  }
  return out;
}

/** The `<serviceLabel>` in `` throw new Error(`<serviceLabel> ${String(res.status)}: …`) ``. */
function serviceLabelFrom(fn: AstNode): string | undefined {
  const thrown = find(fn, (n) => n.type === "ThrowStatement");
  if (thrown === undefined) return undefined;
  const template = find(thrown, (n) => n.type === "TemplateLiteral");
  const head = template === undefined ? undefined : templateHead(template);
  return head === undefined ? undefined : head.replace(/ $/, "");
}

/**
 * The read helper, as src/emit/server/fetch-helper.ts writes it. Recognized by shape rather
 * than by name: the local is derived from the spec by formula, so matching on a name would
 * only recognize the connectors whose author happened to agree with the formula.
 */
export function recognizeFetchHelper(
  statements: readonly AstNode[],
  claims: ClaimSet,
): FetchHelperFields | undefined {
  for (const s of statements) {
    if (s.type !== "FunctionDeclaration" || s["async"] !== true) continue;

    const fetchCall = find(
      s,
      (n) => n.type === "CallExpression" && (n["callee"] as AstNode)["name"] === "fetch",
    );
    if (fetchCall === undefined) continue;

    const url = (fetchCall["arguments"] as AstNode[])[0];
    const base = url === undefined ? undefined : templateHead(url);
    const headers = inlineHeaders(fetchCall);
    const serviceLabel = serviceLabelFrom(s);
    const local = String((s["id"] as AstNode | undefined)?.["name"] ?? "");
    if (base === undefined || headers === undefined || serviceLabel === undefined) continue;

    claims.claim(s, "fetch-helper");
    return { local, base, serviceLabel, inlineHeaders: headers };
  }
  return undefined;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun test test/scripts/derive-fetch-helper.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/_lib/derive/server/fetch-helper.ts test/scripts/derive-fetch-helper.test.ts
git commit -m "feat(reach): recognize the hand-rolled read helper"
```

---

### Task 7: The zod argument recognizer

**Files:**
- Create: `scripts/_lib/derive/server/args.ts`
- Test: `test/scripts/derive-args.test.ts`

**Interfaces:**
- Consumes: `AstNode`.
- Produces: `recognizeArgs(node: AstNode): Record<string, ArgFields> | undefined` where `type ArgFields = { type: "string" | "number" | "boolean"; optional?: true; int?: true; min?: number; max?: number }`. Claims nothing — the caller (Task 9) claims the whole `reg(…)` statement.

This inverts `renderOne` in `src/emit/server/args.ts`, which builds `z.<type>()` then appends
`.int()`, `.min(n)`, `.max(n)`, `.optional()` in that fixed order.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/derive-args.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { recognizeArgs } from "../../scripts/_lib/derive/server/args.ts";

function argsOf(expression: string) {
  const statement = parseModule(`const x = ${expression};`)[0]!;
  const init = (statement["declarations"] as { init: unknown }[])[0]!.init;
  return recognizeArgs(init as never);
}

describe("recognizeArgs", () => {
  it("reads an empty schema", () => {
    expect(argsOf("z.object({})")).toEqual({});
  });

  it("reads a plain string arg", () => {
    expect(argsOf("z.object({ q: z.string() })")).toEqual({ q: { type: "string" } });
  });

  it("reads optional", () => {
    expect(argsOf("z.object({ only_open: z.boolean().optional() })")).toEqual({
      only_open: { type: "boolean", optional: true },
    });
  });

  it("reads the int/min/max chain the emitter writes for a bounded number", () => {
    expect(argsOf("z.object({ limit: z.number().int().min(1).max(100).optional() })")).toEqual({
      limit: { type: "number", int: true, min: 1, max: 100, optional: true },
    });
  });

  it("returns undefined for a modifier it does not model, rather than dropping it", () => {
    expect(argsOf("z.object({ q: z.string().email() })")).toBeUndefined();
  });

  it("returns undefined for anything that is not a z.object call", () => {
    expect(argsOf("searchToolInputSchema")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/scripts/derive-args.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/args.ts`**

```ts
import type { AstNode } from "../ast.ts";

export type ArgFields = {
  type: "string" | "number" | "boolean";
  optional?: true;
  int?: true;
  min?: number;
  max?: number;
};

const BASE_TYPES = new Set(["string", "number", "boolean"]);

/**
 * Unwind `z.number().int().min(1).optional()` from the outside in.
 *
 * Returns undefined on the first modifier this recognizer does not model. That is deliberate:
 * silently dropping `.email()` would derive a spec that regenerates a DIFFERENT schema and then
 * report the byte mismatch as a mystery, instead of naming the modifier as the blocker.
 */
export function recognizeArgs(node: AstNode): Record<string, ArgFields> | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = node["callee"] as AstNode;
  if (callee.type !== "MemberExpression") return undefined;
  if ((callee["object"] as AstNode)["name"] !== "z") return undefined;
  if ((callee["property"] as AstNode)["name"] !== "object") return undefined;

  const properties = ((node["arguments"] as AstNode[])[0]?.["properties"] as AstNode[]) ?? [];
  const out: Record<string, ArgFields> = {};
  for (const property of properties) {
    const key = property["key"] as AstNode;
    const name = typeof key["value"] === "string" ? key["value"] : String(key["name"] ?? "");
    const arg = recognizeOne(property["value"] as AstNode);
    if (name === "" || arg === undefined) return undefined;
    out[name] = arg;
  }
  return out;
}

function recognizeOne(node: AstNode): ArgFields | undefined {
  const modifiers: { name: string; args: AstNode[] }[] = [];
  let current = node;

  while (current.type === "CallExpression") {
    const callee = current["callee"] as AstNode;
    if (callee.type !== "MemberExpression") return undefined;
    const property = (callee["property"] as AstNode)["name"];
    modifiers.push({ name: String(property), args: current["arguments"] as AstNode[] });
    current = callee["object"] as AstNode;
  }

  // The innermost receiver must be `z`, and the innermost call its base type.
  if (current.type !== "Identifier" || current["name"] !== "z") return undefined;
  const base = modifiers.pop();
  if (base === undefined || !BASE_TYPES.has(base.name)) return undefined;

  const out: ArgFields = { type: base.name as ArgFields["type"] };
  for (const modifier of modifiers.reverse()) {
    if (modifier.name === "optional") out.optional = true;
    else if (modifier.name === "int") out.int = true;
    else if (modifier.name === "min") out.min = Number(modifier.args[0]?.["value"]);
    else if (modifier.name === "max") out.max = Number(modifier.args[0]?.["value"]);
    else return undefined;
  }
  return out;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun test test/scripts/derive-args.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/_lib/derive/server/args.ts test/scripts/derive-args.test.ts
git commit -m "feat(reach): recognize zod argument schemas"
```

---

### Task 8: The path-template recognizer

**Files:**
- Create: `scripts/_lib/derive/server/path-template.ts`
- Test: `test/scripts/derive-path-template.test.ts`

**Interfaces:**
- Consumes: `AstNode`.
- Produces: `recognizePath(node: AstNode, locals: ReadonlyMap<string, string>): string | undefined`. `locals` maps an emitted hoisted-const name to the argument name it came from, so `${only}` recovers as `${arg.only_open|bool}`.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/derive-path-template.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { recognizePath } from "../../scripts/_lib/derive/server/path-template.ts";

function pathOf(expression: string, locals: Map<string, string> = new Map()) {
  const statement = parseModule(`const x = ${expression};`)[0]!;
  const init = (statement["declarations"] as { init: unknown }[])[0]!.init;
  return recognizePath(init as never, locals);
}

describe("recognizePath", () => {
  it("reads a static string path", () => {
    expect(pathOf('"/v2/applications.json"')).toBe("/v2/applications.json");
  });

  it("reads a template whose expression is a hoisted boolean local", () => {
    expect(pathOf("`/v2/alerts.json?only_open=${only}`", new Map([["only", "only_open"]]))).toBe(
      "/v2/alerts.json?only_open=${arg.only_open|bool}",
    );
  });

  it("reads a template whose expression is an env accessor call", () => {
    expect(pathOf("`/api/${org()}/issues/`")).toBe("/api/${env.org}/issues/");
  });

  it("returns undefined for an expression it cannot name", () => {
    expect(pathOf("`/a/${p.q.toUpperCase()}`")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/scripts/derive-path-template.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/path-template.ts`**

```ts
import type { AstNode } from "../ast.ts";

/**
 * The inverse of src/emit/server/path-template.ts's rendering.
 *
 * A hoisted boolean local recovers as `${arg.<name>|bool}` because that is the only spec form
 * that emits one: renderHoists writes `const <local> = p.<name> === true ? "true" : "false"`
 * for a boolean, and the |bool mode is what asks for that hoist.
 */
export function recognizePath(
  node: AstNode,
  locals: ReadonlyMap<string, string>,
): string | undefined {
  if (typeof node["value"] === "string" && node.type === "StringLiteral") {
    return node["value"];
  }
  if (node.type !== "TemplateLiteral") return undefined;

  const quasis = node["quasis"] as AstNode[];
  const expressions = node["expressions"] as AstNode[];
  let out = "";

  for (const [i, quasi] of quasis.entries()) {
    out += String((quasi["value"] as { cooked?: string }).cooked ?? "");
    const expression = expressions[i];
    if (expression === undefined) continue;

    const placeholder = placeholderFor(expression, locals);
    if (placeholder === undefined) return undefined;
    out += placeholder;
  }
  return out;
}

function placeholderFor(
  expression: AstNode,
  locals: ReadonlyMap<string, string>,
): string | undefined {
  if (expression.type === "Identifier") {
    const argName = locals.get(String(expression["name"]));
    return argName === undefined ? undefined : `\${arg.${argName}|bool}`;
  }
  if (expression.type === "CallExpression") {
    const callee = expression["callee"] as AstNode;
    if (callee.type === "Identifier" && (expression["arguments"] as AstNode[]).length === 0) {
      return `\${env.${String(callee["name"])}}`;
    }
  }
  if (expression.type === "MemberExpression") {
    const object = expression["object"] as AstNode;
    const property = expression["property"] as AstNode;
    if (object.type === "Identifier" && property.type === "Identifier") {
      return `\${arg.${String(property["name"])}}`;
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun test test/scripts/derive-path-template.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/_lib/derive/server/path-template.ts test/scripts/derive-path-template.test.ts
git commit -m "feat(reach): recognize tool path templates"
```

---

### Task 9: The hand-rolled tool recognizer

**Files:**
- Create: `scripts/_lib/derive/server/tools-hand.ts`
- Test: `test/scripts/derive-tools-hand.test.ts`

**Interfaces:**
- Consumes: `AstNode`, `ClaimSet`, `recognizeArgs`, `recognizePath`.
- Produces: `recognizeTools(statements: readonly AstNode[], claims: ClaimSet): ToolFields[] | undefined` where `type ToolFields = { name: string; description: string; args: Record<string, ArgFields>; path: string; handlerStyle?: "block" }`. Returns `undefined` when any `reg(…)` call fails to recognize, so a partially-understood connector is blocked rather than half-derived.

Two handler shapes exist, both from `src/emit/server/tools-hand.ts`: the concise
expression-bodied arrow (`async () => jsonResult(await nrGet("…"))`) and the block body, which
may be preceded inside the same arrow by hoisted argument consts.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/derive-tools-hand.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";
import { recognizeTools } from "../../scripts/_lib/derive/server/tools-hand.ts";

const CONCISE = [
  'reg("newrelic_application_list", "List APM applications.", z.object({}), async () =>',
  '  jsonResult(await nrGet("/v2/applications.json")),',
  ");",
].join("\n");

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

function run(source: string) {
  const statements = parseModule(source);
  const claims = createClaimSet();
  return { tools: recognizeTools(statements, claims), unclaimed: claims.unclaimed(statements) };
}

describe("recognizeTools", () => {
  it("reads a concise-handler tool", () => {
    const { tools, unclaimed } = run(CONCISE);
    expect(tools).toEqual([
      {
        name: "newrelic_application_list",
        description: "List APM applications.",
        args: {},
        path: "/v2/applications.json",
      },
    ]);
    expect(unclaimed).toEqual([]);
  });

  it("reads a block-handler tool, recovering the hoisted boolean through the path", () => {
    const { tools } = run(BLOCK);
    expect(tools).toEqual([
      {
        name: "newrelic_alert_violations",
        description: "List recent alert violations.",
        args: { only_open: { type: "boolean", optional: true } },
        path: "/v2/alerts_violations.json?only_open=${arg.only_open|bool}",
        handlerStyle: "block",
      },
    ]);
  });

  it("reads several tools in declaration order", () => {
    const { tools } = run(`${CONCISE}\n${BLOCK}`);
    expect(tools?.map((t) => t.name)).toEqual([
      "newrelic_application_list",
      "newrelic_alert_violations",
    ]);
  });

  it("fails the whole connector when one reg call is not understood", () => {
    const source = `${CONCISE}\nreg("x", "y", z.object({}), customHandler);`;
    const { tools, unclaimed } = run(source);
    expect(tools).toBeUndefined();
    expect(unclaimed).toHaveLength(2);
  });

  it("returns an empty list for a module with no reg calls", () => {
    expect(run("const a = 1;").tools).toEqual([]);
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
    expect(run(source).tools).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/scripts/derive-tools-hand.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/tools-hand.ts`**

```ts
import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import { type ArgFields, recognizeArgs } from "./args.ts";
import { recognizePath } from "./path-template.ts";

export type ToolFields = {
  name: string;
  description: string;
  args: Record<string, ArgFields>;
  path: string;
  handlerStyle?: "block";
};

function isRegCall(node: AstNode): AstNode | undefined {
  if (node.type !== "ExpressionStatement") return undefined;
  const call = node["expression"] as AstNode;
  if (call.type !== "CallExpression") return undefined;
  const callee = call["callee"] as AstNode;
  return callee.type === "Identifier" && callee["name"] === "reg" ? call : undefined;
}

/**
 * `const only = p.only_open === true ? "true" : "false";` -> `["only", "only_open"]`.
 *
 * Every part of the shape is checked, not merely enough of it to extract a name. renderHoists
 * writes exactly one form for a boolean, so a conditional differing anywhere is not a hoist —
 * and reading `p.limit === 0 ? "a" : "b"` as one would CLAIM a statement the emitter could not
 * have written, derive `${arg.limit|bool}`, and then fail the byte-diff with no bucket naming
 * why. Over-claiming is what the totality rule exists to prevent, and it has to be prevented
 * inside the matchers too: the rule only sees statements nobody claimed, not statements someone
 * claimed wrongly.
 */
function hoistedLocal(statement: AstNode): [string, string] | undefined {
  if (statement.type !== "VariableDeclaration") return undefined;
  const declarator = (statement["declarations"] as AstNode[])[0];
  const local = (declarator?.["id"] as AstNode | undefined)?.["name"];
  const init = declarator?.["init"] as AstNode | undefined;
  if (typeof local !== "string" || init?.type !== "ConditionalExpression") return undefined;

  if ((init["consequent"] as AstNode)["value"] !== "true") return undefined;
  if ((init["alternate"] as AstNode)["value"] !== "false") return undefined;

  const test = init["test"] as AstNode;
  if (test.type !== "BinaryExpression" || test["operator"] !== "===") return undefined;
  if ((test["right"] as AstNode)["value"] !== true) return undefined;

  const member = test["left"] as AstNode;
  if (member.type !== "MemberExpression") return undefined;
  const argName = (member["property"] as AstNode)["name"];
  return typeof argName === "string" ? [local, argName] : undefined;
}

/** The path argument of `await <helper>(<path>)`, wherever it sits inside the handler. */
function fetchPathArgument(node: AstNode): AstNode | undefined {
  const call = node.type === "CallExpression" ? node : undefined;
  if (call === undefined) return undefined;
  const args = call["arguments"] as AstNode[];
  return args[0];
}

function awaitedCall(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "AwaitExpression") return undefined;
  const call = node["argument"] as AstNode;
  return call.type === "CallExpression" ? call : undefined;
}

/** `jsonResult(await helper(path))` -> the awaited call. */
function jsonResultCall(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "CallExpression") return undefined;
  const callee = node["callee"] as AstNode;
  if (callee.type !== "Identifier" || callee["name"] !== "jsonResult") return undefined;
  return awaitedCall((node["arguments"] as AstNode[])[0]);
}

function recognizeOne(call: AstNode): ToolFields | undefined {
  const [nameNode, descriptionNode, schemaNode, handlerNode] = call["arguments"] as AstNode[];
  const name = nameNode?.["value"];
  const description = descriptionNode?.["value"];
  if (typeof name !== "string" || typeof description !== "string") return undefined;
  if (schemaNode === undefined || handlerNode?.type !== "ArrowFunctionExpression") return undefined;

  const args = recognizeArgs(schemaNode);
  if (args === undefined) return undefined;

  const body = handlerNode["body"] as AstNode;

  if (body.type !== "BlockStatement") {
    const helperCall = jsonResultCall(body);
    const pathNode = helperCall === undefined ? undefined : fetchPathArgument(helperCall);
    const path = pathNode === undefined ? undefined : recognizePath(pathNode, new Map());
    return path === undefined ? undefined : { name, description, args, path };
  }

  const statements = (body["body"] as AstNode[]) ?? [];
  const locals = new Map<string, string>();
  for (const statement of statements.slice(0, -1)) {
    const hoist = hoistedLocal(statement);
    if (hoist === undefined) return undefined;
    locals.set(hoist[0], hoist[1]);
  }

  const last = statements.at(-1);
  if (last?.type !== "ReturnStatement") return undefined;
  const helperCall = jsonResultCall(last["argument"] as AstNode | undefined);
  const pathNode = helperCall === undefined ? undefined : fetchPathArgument(helperCall);
  const path = pathNode === undefined ? undefined : recognizePath(pathNode, locals);
  return path === undefined
    ? undefined
    : { name, description, args, path, handlerStyle: "block" };
}

/**
 * Every `reg(…)` call in the module, or undefined if any one of them is not understood.
 *
 * All-or-nothing on purpose: a connector with nine recognized tools and one bespoke handler is
 * not nine-tenths regenerable, it is blocked, and deriving a spec for the nine would produce a
 * server.ts missing a tool that then fails the byte-diff for a reason the report would attribute
 * to formatting.
 */
export function recognizeTools(
  statements: readonly AstNode[],
  claims: ClaimSet,
): ToolFields[] | undefined {
  const calls = statements.filter((s) => isRegCall(s) !== undefined);
  const tools: ToolFields[] = [];

  for (const statement of calls) {
    const tool = recognizeOne(isRegCall(statement)!);
    if (tool === undefined) return undefined;
    tools.push(tool);
  }

  claims.claim(calls, "tools");
  return tools;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun test test/scripts/derive-tools-hand.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/_lib/derive/server/tools-hand.ts test/scripts/derive-tools-hand.test.ts
git commit -m "feat(reach): recognize hand-rolled tool registrations"
```

---

### Task 10: Composition and the totality rule

**Files:**
- Create: `scripts/_lib/derive/index.ts`
- Test: `test/scripts/derive-index.test.ts`

**Interfaces:**
- Consumes: every recognizer from Tasks 3–9.
- Produces: `type SourceFiles = { server: string; manifest: string }`; `type Derivation = { ok: true; spec: Record<string, unknown> } | { ok: false; blockers: Blocker[] }`; `deriveSpec(files: SourceFiles): Derivation`.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/derive-index.test.ts`. `HAND_ROLLED` below is the emitted `newrelic` shape,
reproduced by hand here rather than read from a checkout:

```ts
import { describe, expect, it } from "bun:test";
import { deriveSpec } from "../../scripts/_lib/derive/index.ts";

const MANIFEST = JSON.stringify({
  id: "newrelic",
  displayName: "New Relic",
  version: "0.1.0",
  description: "Query New Relic.",
  author: "Nimbus",
  entrypoint: "dist/server.js",
  runtime: "bun",
  permissions: { network: ["api.newrelic.com"] },
  hitlRequired: [],
  syncInterval: 300,
  minNimbusVersion: "0.2.0",
});

const SERVER = [
  'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
  'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
  'import { z } from "zod";',
  "",
  "import {",
  "  createRegisterSimpleTool,",
  "  createZodToolRegistrar,",
  "  mcpJsonResult as jsonResult,",
  '} from "../../shared/mcp-tool-kit.ts";',
  "",
  "function apiKey(): string {",
  '  const k = process.env["NEW_RELIC_API_KEY"]?.trim();',
  '  if (k === undefined || k === "") {',
  '    throw new Error("NEW_RELIC_API_KEY is not set");',
  "  }",
  "  return k;",
  "}",
  "",
  "async function nrGet(path: string): Promise<unknown> {",
  "  const res = await fetch(`https://api.newrelic.com${path}`, {",
  '    headers: { "X-Api-Key": apiKey(), Accept: "application/json" },',
  "  });",
  "  const text = await res.text();",
  "  if (!res.ok) {",
  "    throw new Error(`New Relic ${String(res.status)}: ${text.slice(0, 400)}`);",
  "  }",
  "  return JSON.parse(text) as unknown;",
  "}",
  "",
  'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
  "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
  "",
  'reg("newrelic_application_list", "List APM applications.", z.object({}), async () =>',
  '  jsonResult(await nrGet("/v2/applications.json")),',
  ");",
  "",
  "const transport = new StdioServerTransport();",
  "await mcp.connect(transport);",
].join("\n");

describe("deriveSpec", () => {
  it("derives a whole hand-rolled connector", () => {
    const result = deriveSpec({ server: SERVER, manifest: MANIFEST });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.spec).toMatchObject({
      name: "newrelic",
      displayName: "New Relic",
      serviceLabel: "New Relic",
      style: "hand-rolled",
      env: [
        { vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true },
      ],
      fetchHelper: { local: "nrGet", base: "https://api.newrelic.com" },
    });
  });

  it("blocks a connector with one unrecognized statement, naming it", () => {
    const server = `${SERVER}\nimport { listTools } from "./tools.ts";`;
    const result = deriveSpec({ server, manifest: MANIFEST });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["import-from:./tools.ts"]);
  });

  it("reports a parse failure as a blocker rather than throwing", () => {
    const result = deriveSpec({ server: "const = ;", manifest: MANIFEST });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]?.kind).toBe("parse-error");
  });

  it("reports an unreadable manifest as a blocker rather than throwing", () => {
    const result = deriveSpec({ server: SERVER, manifest: "{not json" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]?.kind).toBe("no-manifest");
  });

  it("blocks a style whose frame it does not recognize", () => {
    const server = 'import { runReadOnlyMcpConnector } from "../../shared/read-only-kit.ts";';
    const result = deriveSpec({ server, manifest: MANIFEST });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]?.kind).toBe("no-frame");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/scripts/derive-index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `derive/index.ts`**

```ts
import { parseModule } from "./ast.ts";
import { type Blocker, blockerFor } from "./blockers.ts";
import { createClaimSet } from "./claims.ts";
import { deriveManifest } from "./manifest.ts";
import { recognizeEnv } from "./server/env.ts";
import { recognizeFetchHelper } from "./server/fetch-helper.ts";
import { recognizeFrame } from "./server/index.ts";
import { recognizeTools } from "./server/tools-hand.ts";

export type SourceFiles = { server: string; manifest: string };

export type Derivation =
  | { ok: true; spec: Record<string, unknown> }
  | { ok: false; blockers: Blocker[] };

function blocked(kind: string, detail: string): Derivation {
  return { ok: false, blockers: [{ kind, detail, line: 0 }] };
}

/**
 * Derive a spec object from one connector's source, or report what stopped it.
 *
 * The totality rule is the last step and it has no exceptions: every top-level statement must be
 * covered by some recognizer's claim. There is no "ignore the rest" path, because a scrape that
 * ignores what it does not recognize reports silence as absence — the method that produced three
 * consecutive wrong reach numbers.
 *
 * The returned spec is RAW, not parsed. parseSpec and validateSpec are the `emits` tier
 * boundary and run in the reporting layer, so a derived spec that trips RESERVED_IDENTIFIERS is
 * counted rather than thrown.
 */
export function deriveSpec(files: SourceFiles): Derivation {
  let manifest;
  try {
    manifest = deriveManifest(files.manifest);
  } catch (err) {
    return blocked("no-manifest", err instanceof Error ? err.message : String(err));
  }

  let statements;
  try {
    statements = parseModule(files.server);
  } catch (err) {
    return blocked("parse-error", err instanceof Error ? err.message : String(err));
  }

  const claims = createClaimSet();
  const frame = recognizeFrame(statements, claims);
  if (frame === undefined) {
    return blocked("no-frame", "src/server.ts is not the hand-rolled frame");
  }

  const env = recognizeEnv(statements, claims);
  const fetchHelper = recognizeFetchHelper(statements, claims);
  const tools = recognizeTools(statements, claims);

  const unclaimed = claims.unclaimed(statements);
  if (unclaimed.length > 0) {
    return { ok: false, blockers: unclaimed.map((n) => blockerFor(n, files.server)) };
  }
  if (fetchHelper === undefined) {
    return blocked("no-fetch-helper", "no read helper recognized");
  }
  if (tools === undefined) {
    return blocked("unrecognized-handler", "a reg() handler was not understood");
  }

  const { serviceLabel, ...helper } = fetchHelper;
  return {
    ok: true,
    spec: {
      name: frame.name,
      displayName: manifest.displayName,
      description: manifest.description,
      serviceLabel,
      style: "hand-rolled",
      network: manifest.network,
      ...(manifest.id === undefined ? {} : { id: manifest.id }),
      ...(manifest.filesystem === undefined ? {} : { filesystem: manifest.filesystem }),
      syncInterval: manifest.syncInterval,
      minNimbusVersion: manifest.minNimbusVersion,
      env,
      fetchHelper: helper,
      tools,
    },
  };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun test test/scripts/derive-index.test.ts`
Expected: PASS, 5 tests.

If the first test fails on an unclaimed statement, the blocker's `kind` names which recognizer is
missing it. Fix the recognizer; do not add an exception to the totality rule.

- [ ] **Step 5: Commit**

```bash
git add scripts/_lib/derive/index.ts test/scripts/derive-index.test.ts
git commit -m "feat(reach): compose the recognizers under the totality rule"
```

---

### Task 11: The hermetic round-trip test

**Files:**
- Test: `test/scripts/derive-round-trip.test.ts`

**Interfaces:**
- Consumes: `deriveSpec`; `parseSpec` from `src/spec.ts`; `generate` from `src/emit/index.ts`; `formatAll`/`initFormatter` from `src/format.ts`.
- Produces: nothing importable. This is the test that keeps every later recognizer honest.

This is the centrepiece of the plan. It needs no Nimbus checkout, runs in CI, and gives the
deriver a corpus made entirely of bytes this repository emitted — no connector source in `test/`.

- [ ] **Step 1: Write the test**

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";
import { deriveSpec } from "../../scripts/_lib/derive/index.ts";

/** Fixtures this plan's recognizers cover. Plan 2 moves entries out of BLOCKED into here. */
const ROUND_TRIP = ["newrelic", "datadog", "grafana", "sentry"];

/**
 * Fixtures that must derive as BLOCKED, each with the construct that stops it. Listed so the
 * gap is on screen on every run rather than implied by absence — the same reason
 * fixtures/expectations.json omits a file instead of hiding it.
 */
const BLOCKED: Record<string, string> = {
  bitrise: "read-only-kit frame",
  dependencytrack: "read-only-kit frame",
  discord: "rest-kit frame",
  "google-meet": "rest-kit frame",
  mercury: "read-only-kit frame",
  netlify: "read-only-kit frame",
  zendesk: "read-only-kit frame",
};

function emitted(name: string): { server: string; manifest: string } {
  const specPath = join(import.meta.dir, "..", "..", "fixtures", `${name}.spec.json`);
  const spec = parseSpec(JSON.parse(readFileSync(specPath, "utf8")));
  const files = formatAll(generate(spec));
  const read = (path: string): string => {
    const file = files.find((f) => displayPath(f.path) === path);
    if (file === undefined) throw new Error(`${name} emitted no ${path}`);
    return file.content;
  };
  return { server: read("src/server.ts"), manifest: read("nimbus.extension.json") };
}

function serverOf(spec: ReturnType<typeof parseSpec>): string {
  const file = formatAll(generate(spec)).find((f) => displayPath(f.path) === "src/server.ts");
  return file?.content ?? "";
}

beforeAll(async () => {
  await initFormatter();
});

describe("deriveSpec round-trips this repository's own output", () => {
  for (const name of ROUND_TRIP) {
    it(`re-emits an identical src/server.ts for ${name}`, () => {
      const files = emitted(name);
      const derivation = deriveSpec(files);

      if (!derivation.ok) {
        throw new Error(
          `${name} did not derive: ${derivation.blockers.map((b) => b.kind).join(", ")}`,
        );
      }
      expect(serverOf(parseSpec(derivation.spec))).toBe(files.server);
    });
  }

  for (const [name, reason] of Object.entries(BLOCKED)) {
    it(`blocks ${name} (${reason}) rather than deriving something wrong`, () => {
      const derivation = deriveSpec(emitted(name));
      expect(derivation.ok).toBe(false);
    });
  }
});
```

- [ ] **Step 2: Run it**

Run: `bun test test/scripts/derive-round-trip.test.ts`

- [ ] **Step 3: Reconcile the two lists with reality**

Each `ROUND_TRIP` failure prints the blocker kinds that stopped that fixture. For each one, decide
between exactly two outcomes, and record which:

- **The blocker names a construct this plan's recognizers should cover** — a shape in
  `datadog`/`grafana`/`sentry` that `newrelic` does not exercise. Fix the recognizer named by the
  bucket, in the task that owns it, and re-run.
- **The blocker names a construct plan 2 owns** — a search tool, a write body, a query. Move that
  fixture from `ROUND_TRIP` into `BLOCKED` with the bucket as its reason string.

Do **not** loosen an assertion to make a fixture pass, and do not delete a fixture from both
lists — an unlisted fixture is a gap nobody can see.

- [ ] **Step 4: Run the full suite and the other gates**

Run: `bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/`
Expected: all clean, and per-file coverage floors met for every new `scripts/_lib/` module.

- [ ] **Step 5: Commit**

```bash
git add test/scripts/derive-round-trip.test.ts
git commit -m "test(reach): round-trip the deriver against this repo's own emitted output"
```

---

### Task 12: Tiering and the report

**Files:**
- Create: `scripts/_lib/reach.ts`
- Test: `test/scripts/reach.test.ts`

**Interfaces:**
- Consumes: `Derivation`, `Blocker`.
- Produces:
  - `type Tier = "blocked" | "emits" | "server-identical" | "all-identical"`
  - `type ConnectorResult = { name: string; tier: Tier; blockers: Blocker[] }`
  - `tierFor(args: { derivation: Derivation; generated?: readonly GeneratedFile[]; real?: ReadonlyMap<string, string> }): Tier`
  - `histogram(results: readonly ConnectorResult[]): { kind: string; count: number; examples: string[] }[]`
  - `summaryLines(results: readonly ConnectorResult[]): string[]`
  - `selectConnectors(names: readonly string[], all: readonly string[]): string[]`

`tierFor` takes already-generated files and an already-read map of the real connector's files, so
it stays pure — the shell in Task 14 does the reading.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/reach.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { histogram, selectConnectors, summaryLines, tierFor } from "../../scripts/_lib/reach.ts";

const SPEC = { name: "x" };
const OK = { ok: true as const, spec: SPEC };
const BLOCKED = {
  ok: false as const,
  blockers: [{ kind: "import-from:./tools.ts", detail: "…", line: 3 }],
};

const files = (server: string, readme: string) => [
  { path: ["src", "server.ts"], content: server },
  { path: ["README.md"], content: readme },
];
const real = (server: string, readme: string) =>
  new Map([
    ["src/server.ts", server],
    ["README.md", readme],
  ]);

describe("tierFor", () => {
  it("is blocked when derivation failed", () => {
    expect(tierFor({ derivation: BLOCKED })).toBe("blocked");
  });

  it("is emits when nothing was generated to compare", () => {
    expect(tierFor({ derivation: OK })).toBe("emits");
  });

  it("is emits when server.ts differs", () => {
    expect(
      tierFor({ derivation: OK, generated: files("a", "r"), real: real("b", "r") }),
    ).toBe("emits");
  });

  it("is server-identical when server.ts matches but another file does not", () => {
    expect(
      tierFor({ derivation: OK, generated: files("a", "r1"), real: real("a", "r2") }),
    ).toBe("server-identical");
  });

  it("is all-identical when every generated file matches", () => {
    expect(
      tierFor({ derivation: OK, generated: files("a", "r"), real: real("a", "r") }),
    ).toBe("all-identical");
  });

  it("is server-identical, not all-identical, when a generated file is absent upstream", () => {
    expect(
      tierFor({ derivation: OK, generated: files("a", "r"), real: new Map([["src/server.ts", "a"]]) }),
    ).toBe("server-identical");
  });
});

describe("histogram", () => {
  it("counts buckets most common first and names examples", () => {
    const results = [
      { name: "snyk", tier: "blocked" as const, blockers: BLOCKED.blockers },
      { name: "wiz", tier: "blocked" as const, blockers: BLOCKED.blockers },
      {
        name: "zoom",
        tier: "blocked" as const,
        blockers: [{ kind: "call:safeCliArg", detail: "…", line: 1 }],
      },
    ];
    expect(histogram(results)).toEqual([
      { kind: "import-from:./tools.ts", count: 2, examples: ["snyk", "wiz"] },
      { kind: "call:safeCliArg", count: 1, examples: ["zoom"] },
    ]);
  });

  it("counts a connector once per distinct bucket, not once per blocker", () => {
    const results = [
      {
        name: "a",
        tier: "blocked" as const,
        blockers: [
          { kind: "k", detail: "1", line: 1 },
          { kind: "k", detail: "2", line: 2 },
        ],
      },
    ];
    expect(histogram(results)).toEqual([{ kind: "k", count: 1, examples: ["a"] }]);
  });
});

describe("selectConnectors", () => {
  it("returns every connector when no names are given", () => {
    expect(selectConnectors([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns the named connectors when names are given", () => {
    expect(selectConnectors(["b"], ["a", "b"])).toEqual(["b"]);
  });

  it("refuses an empty corpus rather than reporting a reach number over nothing", () => {
    expect(() => selectConnectors([], [])).toThrow(/nothing measured/i);
  });
});

describe("summaryLines", () => {
  it("reports each tier as a cumulative count, headline marked", () => {
    const results = [
      { name: "a", tier: "all-identical" as const, blockers: [] },
      { name: "b", tier: "server-identical" as const, blockers: [] },
      { name: "c", tier: "emits" as const, blockers: [] },
      { name: "d", tier: "blocked" as const, blockers: [] },
    ];
    expect(summaryLines(results).join("\n")).toContain("REACH  2/4");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/scripts/reach.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `scripts/_lib/reach.ts`**

```ts
import type { Blocker } from "./derive/blockers.ts";
import type { Derivation } from "./derive/index.ts";
import { displayPath, type GeneratedFile } from "../../src/types.ts";

export type Tier = "blocked" | "emits" | "server-identical" | "all-identical";

export type ConnectorResult = { name: string; tier: Tier; blockers: Blocker[] };

const SERVER = "src/server.ts";

/**
 * Tiers are cumulative: all-identical implies server-identical implies emits.
 *
 * A generated file with no counterpart upstream counts as a mismatch, not as a pass — 15 of the
 * 94 connectors carry no test/sandbox.test.ts, and treating a missing file as agreement would
 * report those as all-identical on the strength of a file that is not there.
 */
export function tierFor(args: {
  derivation: Derivation;
  generated?: readonly GeneratedFile[];
  real?: ReadonlyMap<string, string>;
}): Tier {
  if (!args.derivation.ok) return "blocked";
  const { generated, real } = args;
  if (generated === undefined || real === undefined) return "emits";

  const matches = (path: string): boolean => {
    const file = generated.find((f) => displayPath(f.path) === path);
    return file !== undefined && real.get(path) === file.content;
  };

  if (!matches(SERVER)) return "emits";
  return generated.every((f) => matches(displayPath(f.path)))
    ? "all-identical"
    : "server-identical";
}

/** Blocker buckets, most common first, counting each connector once per distinct kind. */
export function histogram(
  results: readonly ConnectorResult[],
): { kind: string; count: number; examples: string[] }[] {
  const byKind = new Map<string, string[]>();
  for (const result of results) {
    for (const kind of new Set(result.blockers.map((b) => b.kind))) {
      byKind.set(kind, [...(byKind.get(kind) ?? []), result.name]);
    }
  }
  return [...byKind.entries()]
    .map(([kind, examples]) => ({ kind, count: examples.length, examples }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

const ORDER: Tier[] = ["emits", "server-identical", "all-identical"];

function atLeast(results: readonly ConnectorResult[], tier: Tier): number {
  const floor = ORDER.indexOf(tier);
  return results.filter((r) => ORDER.indexOf(r.tier) >= floor).length;
}

/**
 * The connectors to measure, refusing the one way this harness could report a vacuous pass.
 *
 * Mirrors selectFixtures in scripts/_lib/golden-diff.ts: an empty measurement set must never
 * produce a number, because "0 of 0" reads as a result rather than as an empty run.
 */
export function selectConnectors(names: readonly string[], all: readonly string[]): string[] {
  const selected = names.length > 0 ? [...names] : [...all];
  if (selected.length === 0) {
    throw new Error(
      "No connectors found under packages/mcp-connectors. Refusing to report a reach number " +
        "with nothing measured.",
    );
  }
  return selected;
}

export function summaryLines(results: readonly ConnectorResult[]): string[] {
  const total = results.length;
  return [
    `REACH  ${atLeast(results, "server-identical")}/${total}  (server.ts byte-identical)`,
    "",
    `  spec derived + emits   ${atLeast(results, "emits")}/${total}`,
    `  server.ts identical    ${atLeast(results, "server-identical")}/${total}   <- headline`,
    `  all files identical    ${atLeast(results, "all-identical")}/${total}`,
  ];
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun test test/scripts/reach.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/_lib/reach.ts test/scripts/reach.test.ts
git commit -m "feat(reach): tier connectors and summarise the corpus"
```

---

### Task 13: The baseline

**Files:**
- Create: `scripts/_lib/reach-baseline.ts`
- Test: `test/scripts/reach-baseline.test.ts`

**Interfaces:**
- Consumes: `ConnectorResult`, `Tier`.
- Produces:
  - `type Baseline = { nimbusCommit: string; tiers: Record<string, Tier> }`
  - `buildBaseline(commit: string, results: readonly ConnectorResult[]): Baseline`
  - `compareBaseline(baseline: Baseline, results: readonly ConnectorResult[], commit: string): { refusal?: string; regressions: { name: string; from: Tier; to: Tier }[] }`
  - `assertComparable(args: { commit: string; dirty: boolean; gitError?: string }): string | undefined` — the refusal message, or `undefined` when comparison is allowed

- [ ] **Step 1: Write the failing test**

Create `test/scripts/reach-baseline.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  assertComparable,
  buildBaseline,
  compareBaseline,
} from "../../scripts/_lib/reach-baseline.ts";

const results = [
  { name: "newrelic", tier: "all-identical" as const, blockers: [] },
  { name: "netlify", tier: "emits" as const, blockers: [] },
];

describe("buildBaseline", () => {
  it("records the commit and every connector's tier", () => {
    expect(buildBaseline("f4e9d93d", results)).toEqual({
      nimbusCommit: "f4e9d93d",
      tiers: { newrelic: "all-identical", netlify: "emits" },
    });
  });
});

describe("assertComparable", () => {
  it("allows a clean checkout", () => {
    expect(assertComparable({ commit: "f4e9d93d", dirty: false })).toBeUndefined();
  });

  it("refuses a dirty checkout, because the commit would describe bytes that are not there", () => {
    expect(assertComparable({ commit: "f4e9d93d", dirty: true })).toMatch(/dirty/i);
  });

  it("refuses when the root is not a git checkout", () => {
    expect(assertComparable({ commit: "", dirty: false })).toMatch(/not a git checkout/i);
  });

  it("names git itself as the problem when git could not run at all", () => {
    const message = assertComparable({ commit: "", dirty: false, gitError: "spawn git ENOENT" });
    expect(message).toMatch(/spawn git ENOENT/);
    expect(message).not.toMatch(/not a git checkout/i);
  });
});

describe("compareBaseline", () => {
  const baseline = buildBaseline("f4e9d93d", results);

  it("refuses to compare across revisions rather than producing a verdict", () => {
    const out = compareBaseline(baseline, results, "0000000");
    expect(out.refusal).toMatch(/f4e9d93d/);
    expect(out.regressions).toEqual([]);
  });

  it("reports nothing when every tier holds", () => {
    expect(compareBaseline(baseline, results, "f4e9d93d")).toEqual({ regressions: [] });
  });

  it("reports a connector that lost a tier", () => {
    const worse = [{ name: "newrelic", tier: "emits" as const, blockers: [] }, results[1]!];
    expect(compareBaseline(baseline, worse, "f4e9d93d").regressions).toEqual([
      { name: "newrelic", from: "all-identical", to: "emits" },
    ]);
  });

  it("does not report an improvement as a regression", () => {
    const better = [results[0]!, { name: "netlify", tier: "server-identical" as const, blockers: [] }];
    expect(compareBaseline(baseline, better, "f4e9d93d").regressions).toEqual([]);
  });

  it("treats a connector missing from the run as a regression to blocked", () => {
    const out = compareBaseline(baseline, [results[0]!], "f4e9d93d");
    expect(out.regressions).toEqual([{ name: "netlify", from: "emits", to: "blocked" }]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/scripts/reach-baseline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `scripts/_lib/reach-baseline.ts`**

```ts
import type { ConnectorResult, Tier } from "./reach.ts";

export type Baseline = { nimbusCommit: string; tiers: Record<string, Tier> };

const RANK: Tier[] = ["blocked", "emits", "server-identical", "all-identical"];

export function buildBaseline(commit: string, results: readonly ConnectorResult[]): Baseline {
  const tiers: Record<string, Tier> = {};
  for (const r of results) tiers[r.name] = r.tier;
  return { nimbusCommit: commit, tiers };
}

/**
 * Whether this checkout may be baselined or compared at all.
 *
 * A dirty tree is refused for the same reason a cross-revision comparison is: a commit SHA
 * describes a tree, and filing measurements of bytes that differ from it produces a false green
 * WITH a paper trail, which is worse than no record. The caller scopes its dirtiness check to
 * packages/mcp-connectors — the only tree this harness reads — so unrelated work elsewhere in
 * the monorepo does not make the gate something to work around.
 */
export function assertComparable(args: {
  commit: string;
  dirty: boolean;
  gitError?: string;
}): string | undefined {
  // Distinguished from "not a git checkout" because the two send a developer to different
  // problems: one is fixed by installing git, the other by pointing --nimbus-root somewhere
  // else. A single message covering both would be wrong half the time.
  if (args.gitError !== undefined && args.gitError !== "") {
    return `git could not run against the Nimbus root: ${args.gitError}. A baseline needs git to name the commit it measured; the plain report still works without --baseline.`;
  }
  if (args.commit === "") {
    return "The Nimbus root is not a git checkout, so a baseline cannot name what it measured. The plain report still works without --baseline.";
  }
  if (args.dirty) {
    return "The Nimbus checkout is dirty under packages/mcp-connectors, so its commit does not describe the bytes being measured. Commit or stash there, or run without --baseline.";
  }
  return undefined;
}

export function compareBaseline(
  baseline: Baseline,
  results: readonly ConnectorResult[],
  commit: string,
): { refusal?: string; regressions: { name: string; from: Tier; to: Tier }[] } {
  if (baseline.nimbusCommit !== commit) {
    return {
      refusal:
        `The baseline was measured at Nimbus ${baseline.nimbusCommit} and this checkout is at ` +
        `${commit}. Comparing across revisions would produce a verdict spanning two corpora. ` +
        "Check out that revision, or re-baseline with `bun run reach:baseline`.",
      regressions: [],
    };
  }

  const now = new Map(results.map((r) => [r.name, r.tier]));
  const regressions: { name: string; from: Tier; to: Tier }[] = [];
  for (const [name, from] of Object.entries(baseline.tiers)) {
    const to = now.get(name) ?? "blocked";
    if (RANK.indexOf(to) < RANK.indexOf(from)) regressions.push({ name, from, to });
  }
  return { regressions };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun test test/scripts/reach-baseline.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/_lib/reach-baseline.ts test/scripts/reach-baseline.test.ts
git commit -m "feat(reach): compare against a committed baseline, refusing incomparable runs"
```

---

### Task 14: The shells, the scripts and the docs

**Files:**
- Create: `scripts/reach.ts`
- Create: `scripts/reach-baseline.ts`
- Modify: `package.json` (scripts)
- Modify: `CLAUDE.md` (the gates table)
- Modify: `docs/ARCHITECTURE.md` (the harness list)
- Modify: `docs/ROADMAP.md` (Stage E's final task, and *Measuring reach*)

**Interfaces:**
- Consumes: everything above, plus `resolveNimbusRoot` from `src/golden/resolve.ts`, `checkBiomeVersion` from `src/golden/biome-version.ts`, and `initFormatter`/`formatterAvailable`/`biomeVersion` from `src/format.ts`.
- Produces: two executables. Nothing imports them.

These shells are the only untested code in the plan, and that is the same split
`scripts/diff-golden.ts` makes: they do filesystem and git I/O against a checkout that exists
only on a maintainer's machine, so they stay thin enough that reading them is the review.

- [ ] **Step 1: Write `scripts/reach.ts`**

```ts
/**
 * Measures how much of the Nimbus connector corpus this generator can regenerate.
 *
 * Reads the monorepo at runtime from a path, exactly as scripts/diff-golden.ts does, and for the
 * same reason: that repository is AGPL-3.0-only and this one is MIT, so it is never vendored.
 * Consequently this CANNOT run in CI. Do not add a job that skips when the root is absent — a
 * silently-skipping gate is the failure mode this repo keeps removing.
 *
 * No derived spec is ever written to disk. The output is a number and a histogram.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../src/emit/index.ts";
import {
  biomeVersion,
  formatAll,
  formatterAvailable,
  formatterUnavailableReason,
  initFormatter,
} from "../src/format.ts";
import { checkBiomeVersion } from "../src/golden/biome-version.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import { parseSpec } from "../src/spec.ts";
import { validateSpec } from "../src/validate.ts";
import { deriveSpec } from "./_lib/derive/index.ts";
import {
  type ConnectorResult,
  histogram,
  selectConnectors,
  summaryLines,
  tierFor,
} from "./_lib/reach.ts";
import { assertComparable, compareBaseline } from "./_lib/reach-baseline.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(scriptDir, "..", "fixtures", "reach-baseline.json");

export function parseArgs(argv: readonly string[]): {
  names: string[];
  nimbusRoot?: string;
  baseline: boolean;
  verbose: boolean;
} {
  const names: string[] = [];
  let nimbusRoot: string | undefined;
  let baseline = false;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--nimbus-root") nimbusRoot = argv[++i];
    else if (a === "--baseline") baseline = true;
    else if (a === "--verbose") verbose = true;
    else if (a?.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else if (a !== undefined) names.push(a);
  }
  return { names, nimbusRoot, baseline, verbose };
}

/** Exported for scripts/reach-baseline.ts, so the two commands cannot measure differently. */
export function connectorDirs(root: string): string[] {
  const dir = join(root, "packages", "mcp-connectors");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "shared")
    .map((e) => e.name)
    .sort();
}

/**
 * Reads the real connector, normalising line endings on THAT side only — the same asymmetry
 * scripts/_lib/golden-diff.ts's diffAgainstReal uses, and for the same reason: normalise what
 * this repository does not control, compare verbatim what it produces. Normalising the
 * generated side too would mask a CRLF leak from the emitter rather than surface it.
 *
 * Safe because .gitattributes pins `* text=auto eol=lf`, so the working tree is LF even under
 * core.autocrlf=true. Verified on Windows: all six emitted files are LF-only, including
 * README.md, which formatAll does not touch.
 */
function readReal(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (sub: string): void => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const rel = sub === "" ? entry.name : `${sub}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else out.set(rel, readFileSync(join(dir, rel), "utf8").replaceAll("\r\n", "\n"));
    }
  };
  walk("");
  return out;
}

/**
 * Runs git, reporting *why* it produced nothing.
 *
 * `error` is what separates "git is not installed" from "this directory is not a checkout".
 * Collapsing both to an empty string sends a developer whose PATH is missing git off to check
 * their --nimbus-root, which is the wrong problem and the wrong fix.
 */
export function git(root: string, args: string[]): { value: string; error: string } {
  try {
    return {
      value: execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(),
      error: "",
    };
  } catch (err) {
    return { value: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Exported for scripts/reach-baseline.ts. One measurement loop, two commands. */
export function measure(name: string, root: string): ConnectorResult {
  const dir = join(root, "packages", "mcp-connectors", name);
  const real = readReal(dir);
  const server = real.get("src/server.ts");
  const manifest = real.get("nimbus.extension.json");
  if (server === undefined || manifest === undefined) {
    return {
      name,
      tier: "blocked",
      blockers: [{ kind: server === undefined ? "no-server" : "no-manifest", detail: dir, line: 0 }],
    };
  }

  const derivation = deriveSpec({ server, manifest });
  if (!derivation.ok) return { name, tier: "blocked", blockers: derivation.blockers };

  // parseSpec and validateSpec ARE the `emits` tier boundary: a derived spec that trips
  // RESERVED_IDENTIFIERS is genuinely not generatable today, and counting it is the point.
  try {
    const spec = parseSpec(derivation.spec);
    validateSpec(spec);
    const generated = formatAll(generate(spec));
    return { name, tier: tierFor({ derivation, generated, real }), blockers: [] };
  } catch (err) {
    return {
      name,
      tier: "blocked",
      blockers: [
        { kind: "rejected-by-validate", detail: err instanceof Error ? err.message : String(err), line: 0 },
      ],
    };
  }
}

async function main(argv: readonly string[]): Promise<void> {
  await initFormatter();
  if (!formatterAvailable()) {
    throw new Error(
      "@biomejs/biome is required here — this harness byte-compares, and unformatted output " +
        `would produce spurious diffs that read as reach regressions. ${formatterUnavailableReason()}`,
    );
  }

  const { names, nimbusRoot, baseline, verbose } = parseArgs(argv);
  const root = resolveNimbusRoot({ flag: nimbusRoot, env: process.env["NIMBUS_ROOT"], scriptDir });

  const selected = selectConnectors(names, connectorDirs(root));

  const resolvedBiome = biomeVersion();
  console.log(`Nimbus root: ${root}   (${selected.length} connectors)`);
  console.log(`Biome:       ${resolvedBiome}`);
  const warning = checkBiomeVersion(root, resolvedBiome);
  if (warning !== undefined) console.log(warning);
  console.log();

  const results = selected.map((name) => measure(name, root));

  for (const line of summaryLines(results)) console.log(line);
  console.log("\nBlocked by, most common first:");
  for (const bucket of histogram(results)) {
    console.log(`  ${String(bucket.count).padStart(3)}  ${bucket.kind}`);
    if (verbose) console.log(`       ${bucket.examples.join(", ")}`);
  }
  console.log("\n(no derived spec written)");

  if (verbose || names.length > 0) {
    console.log();
    for (const r of results) console.log(`  ${r.tier.padEnd(18)} ${r.name}`);
  }

  if (!baseline) return;

  const head = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--porcelain", "--", "packages/mcp-connectors"]);
  const refusal = assertComparable({
    commit: head.value,
    dirty: status.value !== "",
    gitError: head.error,
  });
  if (refusal !== undefined) {
    console.log(`\n${refusal}`);
    process.exit(2);
  }

  const stored = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Parameters<
    typeof compareBaseline
  >[0];
  const { refusal: mismatch, regressions } = compareBaseline(stored, results, head.value);
  if (mismatch !== undefined) {
    console.log(`\n${mismatch}`);
    process.exit(2);
  }
  for (const r of regressions) console.log(`\nREGRESSED  ${r.name}   ${r.from} -> ${r.to}`);
  if (regressions.length > 0) {
    console.log(
      `\n${regressions.length} connector(s) lost a tier. If the corpus moved, re-baseline; ` +
        "do not edit fixtures/reach-baseline.json to make this pass.",
    );
    process.exit(1);
  }
  console.log("\nNo connector lost a tier.");
}

// Guarded exactly as scripts/diff-golden.ts is, so importing this module cannot run the harness.
if (import.meta.main) {
  await main(process.argv.slice(2));
}
```

- [ ] **Step 2: Write `scripts/reach-baseline.ts`**

```ts
/**
 * Rewrites fixtures/reach-baseline.json from a fresh measurement.
 *
 * Separate from scripts/reach.ts on the scripts/snapshot-update.ts precedent: the thing that
 * rewrites recorded expectations is its own command, so it cannot be reached by adding a flag to
 * the command that checks them.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatterAvailable, formatterUnavailableReason, initFormatter } from "../src/format.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import { assertComparable, buildBaseline } from "./_lib/reach-baseline.ts";
import { selectConnectors } from "./_lib/reach.ts";
// measure, connectorDirs, git and parseArgs are imported rather than reimplemented: two copies
// of the measurement loop would let the baseline and the check that reads it disagree, which is
// the single failure this file must not have.
import { connectorDirs, git, measure, parseArgs } from "./reach.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(scriptDir, "..", "fixtures", "reach-baseline.json");

async function main(argv: readonly string[]): Promise<void> {
  await initFormatter();
  if (!formatterAvailable()) {
    throw new Error(
      "@biomejs/biome is required here — this harness byte-compares, and unformatted output " +
        `would produce spurious diffs that read as reach regressions. ${formatterUnavailableReason()}`,
    );
  }

  const { nimbusRoot } = parseArgs(argv);
  const root = resolveNimbusRoot({ flag: nimbusRoot, env: process.env["NIMBUS_ROOT"], scriptDir });

  const head = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--porcelain", "--", "packages/mcp-connectors"]);
  const refusal = assertComparable({
    commit: head.value,
    dirty: status.value !== "",
    gitError: head.error,
  });
  if (refusal !== undefined) {
    console.log(refusal);
    process.exit(2);
  }

  const results = selectConnectors([], connectorDirs(root)).map((name) => measure(name, root));
  const baseline = buildBaseline(head.value, results);
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, undefined, 2)}\n`);

  console.log(`Wrote ${BASELINE_PATH}`);
  console.log(`  measured at Nimbus ${head.value}`);
  console.log(`  ${results.length} connectors recorded`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
```

Note the import from `./reach.ts`: that module's `main()` is guarded by `import.meta.main`, so
importing it here runs nothing — the same guard, for the same reason, that
`scripts/diff-golden.ts` carries.

- [ ] **Step 3: Add the package scripts**

In `package.json`, alongside `diff:golden`:

```json
"reach": "bun scripts/reach.ts",
"reach:baseline": "bun scripts/reach-baseline.ts"
```

- [ ] **Step 4: Run it against a real checkout**

Run: `bun run reach --nimbus-root <path-to-Nimbus>`

Expected: a tier summary and a histogram. The four hand-rolled fixtures' connectors should reach
`server-identical` or `all-identical`; `rest-kit` and `read-only-kit` connectors should appear
under `no-frame`. If the histogram's largest bucket is `parse-error`, the parser plugins are
wrong — go back to Task 1.

Then: `bun run reach:baseline --nimbus-root <path>` and confirm `fixtures/reach-baseline.json`
is written with a `nimbusCommit` matching `git -C <path> rev-parse HEAD`.

Then: `bun run reach --nimbus-root <path> --baseline` and confirm it reports no regression.

- [ ] **Step 5: Confirm the dirty-checkout refusal actually fires**

In the Nimbus checkout, `touch packages/mcp-connectors/newrelic/scratch.txt`, then run
`bun run reach --nimbus-root <path> --baseline`.

Expected: exit code 2 and the dirty-checkout message. Remove the file afterwards. A refusal that
was never observed firing is a refusal nobody knows works.

- [ ] **Step 6: Update the documentation**

`CLAUDE.md`, in the gates table:

```
| `bun run reach --nimbus-root <path>` | How much of the corpus the spec language reaches | Nimbus checkout |
```

Add to the traps list under it: `reach` measures the spec language's coverage of the corpus and
proves nothing about any individual generated connector that `diff:golden` does not already
prove. It cannot run in CI.

`docs/ARCHITECTURE.md`: add `reach` to the harness list, marked — like `diff:golden` and
`wiring:conformance` — as unable to run in CI.

`docs/ROADMAP.md`: in Stage E, mark the final task `[~]` and note that the method is now
`bun run reach` rather than a hand count. In *Measuring reach*, keep the three wrong-number
post-mortems — they are why the totality rule exists — and add a line pointing at the command.
**Do not write a reach number into any document.** The command is the answer.

- [ ] **Step 7: Run every gate**

Run: `bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/`
Then: `bun run diff:golden --nimbus-root <path>` and confirm `newrelic`, `datadog`, `grafana` and
`sentry` still report `6/6`. This plan touches no emitter, so any movement there is a bug in this
plan's changes.

- [ ] **Step 8: Commit**

```bash
git add scripts/reach.ts scripts/reach-baseline.ts package.json fixtures/reach-baseline.json CLAUDE.md docs/ARCHITECTURE.md docs/ROADMAP.md
git commit -m "feat(reach): add the corpus reach harness and its baseline"
```

---

## Done when

- `bun run reach --nimbus-root <path>` prints a tier summary and a blocker histogram, and writes no spec.
- `bun run reach --baseline` exits non-zero on a tier regression, and exits 2 rather than comparing when the commit differs or the checkout is dirty.
- `test/scripts/derive-round-trip.test.ts` passes in CI with no checkout, and every fixture appears in exactly one of its two lists.
- `bun test`, `bunx tsc --noEmit` and `bunx biome check src/ test/ scripts/` are clean.
- `diff:golden` still reports 6/6 for `newrelic`, `datadog`, `grafana` and `sentry`.
