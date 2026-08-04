# Guarded Accessors and the Two Missing Frames — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

> **Code listings are a starting point, not the authority.** The predecessor plan
> (`2026-08-03-reach-measurement-harness.md`) shipped with ~11 defects in its listings. Where a
> listing here disagrees with `src/` or `scripts/_lib/derive/`, **the source wins** — read it and
> adapt. Every listing below was written against the source as of `e64d777`, but no listing has
> been executed.

**Goal:** Teach the deriver the `read-only-kit` and `rest-kit` frames, on top of an accessor layer
that makes the dominant defect class a compile error, so that `bun run reach`'s 81-connector
`no-frame` bucket becomes named, countable blockers.

**Architecture:** `ast.ts` stops exporting `AstNode`'s index signature; a new `read.ts` becomes the
only module that reads a node's fields, exposing guarded accessors that check `computed`, `kind`
and arity at the point of access. `recognizeFrame` then becomes style-dispatching and returns
*two* statement lists — one for the tool recognizers, one for the totality rule — so that
read-only-kit's nested registrations cannot inherit coverage from a claim on their wrapper.

**Tech Stack:** Bun (test runner, no Node path), TypeScript, `@babel/parser` (devDependency),
Biome 2.5.6 via `@biomejs/js-api` in-process, zod for the spec schema.

## Scope of this plan

This plan covers **commits 1–3** of the design's seven-commit sequence
([`2026-08-04-completing-the-recognizer-set-design.md`](../specs/2026-08-04-completing-the-recognizer-set-design.md)),
plus the blocker split and a re-baseline: the accessor layer, the frame restructure, both new
frames, and `tools-rest`.

**The `search`, `search-filter`, `query` and `body` recognizers get their own plan, written after
Task 7 lands.** This is deliberate, not a truncation. Those four recognizers are written *against*
the accessor layer, and the layer's final shape — which accessors exist, what they return — is an
output of Tasks 1–2, not an input. The predecessor plan's ~11 defects came from writing recognizer
code against an interface that did not exist yet. Plan 1 still delivers working, independently
valuable software: both frames land, fixtures move, and the histogram stops hiding 70 connectors.

## Global Constraints

- **Licensing.** No connector source and no `shared/` source may enter this repository — not
  `src/`, not `test/`, not `fixtures/`. Every test input is hand-written here or produced by this
  repo's own emitter.
- **Byte safety.** `newrelic`, `datadog`, `grafana`, `sentry` must report **6/6** in
  `bun run diff:golden` after every task.
- **Never commit on `main`.** Work happens on `feat/derive-recognizer-completion`, which exists.
- **Conventional Commits.** `feat:` bumps minor, `fix:` bumps patch, `refactor:`/`docs:`/`test:`
  bump nothing.
- **Bun only.** No Node, npm or pnpm path.
- **No `coveragePathIgnorePatterns` entries.** `bunfig.toml` enforces coverage floors **per file**,
  and a file enters the report the moment a test imports it. Every new module ships with its own
  test file.
- **Emitters return UNFORMATTED source**; `formatAll()` runs the real Biome. Never hand-align
  indentation. This plan touches no emitter, but the rule governs any listing that looks like one.
- **Rejecting is always the safe direction.** A rejection is a visible blocker; a wrong claim is a
  wrong number.
- **`test/scripts/derive-round-trip.test.ts` is the guard.** Every fixture must stay in exactly one
  of `ROUND_TRIP` / `BLOCKED`; its "accounts for every fixture" test enforces this.

## Gate commands — check EXIT CODES, never printed output

```bash
bun test --coverage;                          echo "cov_exit=$?"
bunx tsc --noEmit;                            echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;         echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus
```

Piping to `head`/`tail` discards the exit code. Do not do it.

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/_lib/derive/ast.ts` | **Modify.** Parser boundary. `AstNode` loses `[key: string]: unknown`. |
| `scripts/_lib/derive/read.ts` | **Create.** The only module that casts to an indexable node. Guarded accessors + a separate `label*` group. |
| `scripts/_lib/derive/blockers.ts` | **Modify.** Retrofit onto the `label*` group. |
| `scripts/_lib/derive/server/{args,env,fetch-helper,index,path-template,tools-hand}.ts` | **Modify.** Retrofit onto guarded accessors. |
| `scripts/_lib/derive/server/frame.ts` | **Create.** Shared `Frame` type + the read-only-kit and rest-kit recognizers. |
| `scripts/_lib/derive/server/tools-rest.ts` | **Create.** Inverts `src/emit/server/tools-rest.ts`. |
| `scripts/_lib/derive/index.ts` | **Modify.** Style dispatch, `verifyStatements`, rest-kit wiring. |
| `fixtures/zzreadonly.spec.json` | **Create.** Synthetic search-free `read-only-kit` fixture. |
| `fixtures/expectations.json` | **Modify.** `"zzreadonly": []`. |
| `fixtures/reach-baseline.json` | **Regenerate** at Task 7 via `bun run reach:baseline`. |
| `test/scripts/derive-read.test.ts` | **Create.** Unit tests for every accessor. |
| `test/scripts/derive-frame.test.ts` | **Modify.** `recognizeFrame`'s return type changes. |
| `test/scripts/derive-frame-readonly.test.ts` | **Create.** Read-only-kit frame + the containment hazard. |
| `test/scripts/derive-tools-rest.test.ts` | **Create.** Rest-kit registrar and tool calls. |
| `test/scripts/derive-round-trip.test.ts` | **Modify.** Fixtures move `BLOCKED` → `ROUND_TRIP`. |

---

## Task 1: The guarded accessor layer

Creates `read.ts` with unit tests. Nothing consumes it yet, so this task cannot break anything —
which is the point of ordering it first.

**Files:**
- Create: `scripts/_lib/derive/read.ts`
- Create: `test/scripts/derive-read.test.ts`

**Interfaces:**
- Consumes: `AstNode` from `scripts/_lib/derive/ast.ts` (unchanged this task — it still has its
  index signature; Task 2 removes it).
- Produces: every accessor listed in Step 3. Tasks 2–6 use these exclusively.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/derive-read.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import {
  arrowFn,
  awaited,
  blockBody,
  boolLit,
  callTo,
  conditional,
  constDecl,
  expressionOf,
  identName,
  importSource,
  memberName,
  memberObject,
  methodCallTo,
  newOf,
  numberLit,
  numericValue,
  objectProps,
  returnArgument,
  stringLit,
} from "../../scripts/_lib/derive/read.ts";

/** The single top-level statement of `source`. */
function only(source: string) {
  const statements = parseModule(source);
  if (statements.length !== 1) throw new Error(`expected 1 statement, got ${statements.length}`);
  return statements[0]!;
}

/** The init of `const x = <expr>;`. */
function initOf(expr: string) {
  const decl = constDecl(only(`const x = ${expr};`));
  if (decl?.init === undefined) throw new Error(`no init for ${expr}`);
  return decl.init;
}

describe("constDecl", () => {
  it("reads a single const declarator", () => {
    expect(constDecl(only("const a = 1;"))?.name).toBe("a");
  });

  it("rejects let and var — the emitter only ever writes const", () => {
    expect(constDecl(only("let a = 1;"))).toBeUndefined();
    expect(constDecl(only("var a = 1;"))).toBeUndefined();
  });

  it("rejects a multi-declarator statement", () => {
    expect(constDecl(only("const a = 1, b = 2;"))).toBeUndefined();
  });

  it("rejects a destructuring pattern", () => {
    expect(constDecl(only("const { a } = o;"))).toBeUndefined();
  });
});

describe("memberName", () => {
  it("reads a plain property", () => {
    expect(memberName(initOf("p.limit"))).toBe("limit");
  });

  it("rejects a computed member — p[key] is not p.key", () => {
    expect(memberName(initOf("p[key]"))).toBeUndefined();
  });

  it("rejects an optional member — ?. is a different node type", () => {
    expect(memberName(initOf("p?.limit"))).toBeUndefined();
  });

  it("memberObject rejects a computed member too", () => {
    expect(memberObject(initOf("p[key]"))).toBeUndefined();
    expect(identName(memberObject(initOf("p.limit")))).toBe("p");
  });
});

describe("callTo", () => {
  it("returns the arguments on an exact name and arity match", () => {
    expect(callTo(initOf("f(1, 2)"), "f", 2)).toHaveLength(2);
  });

  it("rejects a wrong arity", () => {
    expect(callTo(initOf("f(1)"), "f", 2)).toBeUndefined();
  });

  it("rejects a wrong callee", () => {
    expect(callTo(initOf("g(1, 2)"), "f", 2)).toBeUndefined();
  });

  it("rejects an optional call — f?.() is a different node type", () => {
    expect(callTo(initOf("f?.(1)"), "f", 1)).toBeUndefined();
  });
});

describe("methodCallTo", () => {
  it("matches receiver, property and arity together", () => {
    expect(methodCallTo(initOf("u.searchParams.set(a, b)"), "searchParams", "set", 2)).toHaveLength(
      2,
    );
  });

  it("rejects a computed property — u[set](a, b) is not u.set(a, b)", () => {
    expect(methodCallTo(initOf("u[set](a, b)"), "u", "set", 2)).toBeUndefined();
  });

  it("rejects a different receiver", () => {
    expect(methodCallTo(initOf("v.set(a, b)"), "u", "set", 2)).toBeUndefined();
  });
});

describe("newOf", () => {
  it("matches constructor and arity", () => {
    expect(newOf(initOf("new StdioServerTransport()"), "StdioServerTransport", 0)).toEqual([]);
  });

  it("rejects a wrong arity", () => {
    expect(newOf(initOf("new McpServer()"), "McpServer", 1)).toBeUndefined();
  });
});

describe("objectProps", () => {
  it("reads identifier and string keys", () => {
    const props = objectProps(initOf('({ a: 1, "b-c": 2 })'));
    expect(props?.map((p) => p.key)).toEqual(["a", "b-c"]);
  });

  it("reads a shorthand property as key and value alike", () => {
    const props = objectProps(initOf("({ issueId })"));
    expect(props?.[0]?.key).toBe("issueId");
    expect(identName(props?.[0]?.value)).toBe("issueId");
  });

  it("rejects a computed key — { [K]: v } has no literal name", () => {
    expect(objectProps(initOf("({ [K]: 1 })"))).toBeUndefined();
  });

  it("rejects a spread element", () => {
    expect(objectProps(initOf("({ ...rest })"))).toBeUndefined();
  });
});

describe("literals", () => {
  it("reads each literal type only at its own node type", () => {
    expect(stringLit(initOf('"hi"'))).toBe("hi");
    expect(numberLit(initOf("42"))).toBe(42);
    expect(boolLit(initOf("true"))).toBe(true);
    expect(stringLit(initOf("42"))).toBeUndefined();
    expect(numberLit(initOf('"42"'))).toBeUndefined();
  });

  it("numberLit rejects -1, which Babel parses as a UnaryExpression", () => {
    expect(numberLit(initOf("-1"))).toBeUndefined();
  });

  it("numericValue accepts a signed literal, which ArgSchema permits for min/max/default", () => {
    expect(numericValue(initOf("-1"))).toBe(-1);
    expect(numericValue(initOf("+5"))).toBe(5);
    expect(numericValue(initOf("42"))).toBe(42);
  });

  it("numericValue rejects a unary operator that is not a sign", () => {
    expect(numericValue(initOf("!1"))).toBeUndefined();
    expect(numericValue(initOf("-x"))).toBeUndefined();
  });
});

describe("statement and function readers", () => {
  it("unwraps an expression statement and an await", () => {
    const call = awaited(expressionOf(only("await f();")));
    expect(callTo(call, "f", 0)).toEqual([]);
  });

  it("reads an arrow's params and block body", () => {
    const arrow = arrowFn(initOf("(a, b) => { return 1; }"));
    expect(arrow?.params).toHaveLength(2);
    expect(arrow?.isBlock).toBe(true);
    expect(blockBody(arrow?.body)).toHaveLength(1);
  });

  it("reports an expression-bodied arrow as not a block", () => {
    expect(arrowFn(initOf("(a) => 1"))?.isBlock).toBe(false);
  });

  it("reads a return argument, and undefined for a bare return", () => {
    const arrow = arrowFn(initOf("() => { return 7; }"));
    expect(numberLit(returnArgument(blockBody(arrow?.body)?.[0]))).toBe(7);
  });

  it("reads a conditional's three limbs", () => {
    const c = conditional(initOf('a === true ? "true" : "false"'));
    expect(stringLit(c?.consequent)).toBe("true");
    expect(stringLit(c?.alternate)).toBe("false");
  });

  it("reads an import specifier source", () => {
    expect(importSource(only('import { a } from "./x.ts";'))).toBe("./x.ts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/scripts/derive-read.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/_lib/derive/read.ts'`.

- [ ] **Step 3: Write the accessor layer**

Create `scripts/_lib/derive/read.ts`:

```ts
/**
 * The only module in the deriver that reads a Babel node's fields.
 *
 * Every other module reaches node data through the accessors below, and `ast.ts` deliberately
 * does not export an index signature, so `bunx tsc --noEmit` is what enforces that. This is not
 * style: the reach implementation shipped the same defect eight times across five files —
 * unguarded `computed` member reads, and `VariableDeclaration` matchers not checking
 * `kind === "const"` — and every one was an instance of ONE shape, a matcher that validates part
 * of a construct and claims the whole of it.
 *
 * The totality rule cannot catch that class. It detects statements nobody claimed; it is blind to
 * statements claimed WRONGLY. So the guard has to sit where the value is obtained, which is what
 * these accessors do: `computed`, `kind` and argument count are checked at the only place the
 * field can be read, and every accessor returns `undefined` rather than throwing, so rejecting
 * stays the cheap default.
 *
 * There is deliberately no generic `getChildren(node)`. An untyped child list hands back nodes
 * stripped of WHICH SLOT they came from, and the slot is exactly what the guards depend on — it
 * is how a computed member's key identifier gets read as a property name. Reaching a node field
 * with no accessor means adding an accessor here, never casting at the call site.
 */
import type { AstNode } from "./ast.ts";

/** The indexable view. Private to this module — see the header. */
type RawNode = { readonly [key: string]: unknown };

function raw(node: AstNode): RawNode {
  return node as unknown as RawNode;
}

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** One child node at `key`, or undefined when absent or not a node. */
function child(node: AstNode | undefined, key: string): AstNode | undefined {
  if (node === undefined) return undefined;
  const value = raw(node)[key];
  return isNode(value) ? value : undefined;
}

/** A child node array at `key`, or undefined when absent, not an array, or holding a non-node. */
function childList(node: AstNode | undefined, key: string): AstNode[] | undefined {
  if (node === undefined) return undefined;
  const value = raw(node)[key];
  if (!Array.isArray(value)) return undefined;
  return value.every(isNode) ? (value as AstNode[]) : undefined;
}

function stringField(node: AstNode | undefined, key: string): string | undefined {
  if (node === undefined) return undefined;
  const value = raw(node)[key];
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Identifiers and literals
// ---------------------------------------------------------------------------

export function identName(node: AstNode | undefined): string | undefined {
  if (node?.type !== "Identifier") return undefined;
  return stringField(node, "name");
}

export function isIdent(node: AstNode | undefined, name: string): boolean {
  return identName(node) === name;
}

export function stringLit(node: AstNode | undefined): string | undefined {
  if (node?.type !== "StringLiteral") return undefined;
  const value = raw(node)["value"];
  return typeof value === "string" ? value : undefined;
}

export function numberLit(node: AstNode | undefined): number | undefined {
  if (node?.type !== "NumericLiteral") return undefined;
  const value = raw(node)["value"];
  return typeof value === "number" ? value : undefined;
}

export function boolLit(node: AstNode | undefined): boolean | undefined {
  if (node?.type !== "BooleanLiteral") return undefined;
  const value = raw(node)["value"];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * A numeric value that may carry a sign.
 *
 * Separate from `numberLit` because Babel parses `-1` as a UnaryExpression wrapping a
 * NumericLiteral, and `ArgSchema` constrains sign on NONE of `min`, `max` or `default` — so the
 * emitter can write `-1` and a strict reader would manufacture a blocker on a connector this
 * generator can actually reproduce. Use this for those three; use `numberLit` where the emitter
 * can only write a bare literal (`maxLimit`, pinned `.int().positive()` by ToolSchema).
 */
export function numericValue(node: AstNode | undefined): number | undefined {
  const bare = numberLit(node);
  if (bare !== undefined) return bare;
  if (node?.type !== "UnaryExpression") return undefined;
  if (raw(node)["prefix"] !== true) return undefined;
  const operator = stringField(node, "operator");
  if (operator !== "-" && operator !== "+") return undefined;
  const inner = numberLit(child(node, "argument"));
  if (inner === undefined) return undefined;
  return operator === "-" ? -inner : inner;
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/**
 * `<anything>.<name>` -> "<name>", rejecting computed and optional members.
 *
 * A computed member (`p[key]`) has an Identifier `property` too — it is the KEY variable's name,
 * not a property name — so an unguarded read names things after whatever local indexed the
 * member. `?.` produces OptionalMemberExpression, a distinct node type the emitter never writes.
 */
export function memberName(node: AstNode | undefined): string | undefined {
  if (node?.type !== "MemberExpression") return undefined;
  if (raw(node)["computed"] === true) return undefined;
  return identName(child(node, "property"));
}

/** The receiver of a non-computed member expression. */
export function memberObject(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "MemberExpression") return undefined;
  if (raw(node)["computed"] === true) return undefined;
  return child(node, "object");
}

/** `<receiver>.<name>` where the receiver is exactly that identifier -> "<name>". */
export function memberOn(node: AstNode | undefined, receiver: string): string | undefined {
  if (!isIdent(memberObject(node), receiver)) return undefined;
  return memberName(node);
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

export type ConstDecl = { readonly name: string; readonly init: AstNode | undefined };

/**
 * `const <name> = <init>;` — one declarator, an Identifier binding, `kind === "const"`.
 *
 * `let` and `var` produce the identical VariableDeclaration node; `kind` is the only thing that
 * distinguishes them, and forgetting it is one of the two forms of the defect this module exists
 * to prevent.
 */
export function constDecl(node: AstNode | undefined): ConstDecl | undefined {
  if (node?.type !== "VariableDeclaration") return undefined;
  if (raw(node)["kind"] !== "const") return undefined;
  const declarations = childList(node, "declarations");
  if (declarations === undefined || declarations.length !== 1) return undefined;
  const declarator = declarations[0];
  const name = identName(child(declarator, "id"));
  if (name === undefined) return undefined;
  return { name, init: child(declarator, "init") };
}

export function functionName(node: AstNode | undefined): string | undefined {
  if (node?.type !== "FunctionDeclaration") return undefined;
  return identName(child(node, "id"));
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** The arguments of a plain CallExpression — never an OptionalCallExpression. */
export function callArgs(node: AstNode | undefined): AstNode[] | undefined {
  if (node?.type !== "CallExpression") return undefined;
  return childList(node, "arguments");
}

/** `<callee>(...)` with exactly `argc` arguments -> those arguments. */
export function callTo(
  node: AstNode | undefined,
  callee: string,
  argc: number,
): AstNode[] | undefined {
  const args = callArgs(node);
  if (args === undefined || args.length !== argc) return undefined;
  return isIdent(child(node, "callee"), callee) ? args : undefined;
}

/** `<callee>(...)` with any arity -> its arguments, when the callee is that identifier. */
export function callToAny(node: AstNode | undefined, callee: string): AstNode[] | undefined {
  const args = callArgs(node);
  if (args === undefined) return undefined;
  return isIdent(child(node, "callee"), callee) ? args : undefined;
}

/** `<receiver>.<property>(...)` with exactly `argc` arguments -> those arguments. */
export function methodCallTo(
  node: AstNode | undefined,
  receiver: string,
  property: string,
  argc: number,
): AstNode[] | undefined {
  const args = callArgs(node);
  if (args === undefined || args.length !== argc) return undefined;
  const callee = child(node, "callee");
  if (memberName(callee) !== property) return undefined;
  return isIdent(memberObject(callee), receiver) ? args : undefined;
}

/** `new <ctor>(...)` with exactly `argc` arguments -> those arguments. */
export function newOf(
  node: AstNode | undefined,
  ctor: string,
  argc: number,
): AstNode[] | undefined {
  if (node?.type !== "NewExpression") return undefined;
  const args = childList(node, "arguments");
  if (args === undefined || args.length !== argc) return undefined;
  return isIdent(child(node, "callee"), ctor) ? args : undefined;
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export type Prop = { readonly key: string; readonly value: AstNode };

/**
 * Every property of an ObjectExpression, or undefined if ANY is not a plain non-computed
 * ObjectProperty — a spread, a method, or a `{ [K]: v }` computed key disqualifies the whole
 * object rather than being skipped. A shorthand `{ issueId }` reads as key "issueId" with the
 * Identifier as its value, which is the shape `renderBodyExpr` emits.
 */
export function objectProps(node: AstNode | undefined): Prop[] | undefined {
  if (node?.type !== "ObjectExpression") return undefined;
  const properties = childList(node, "properties");
  if (properties === undefined) return undefined;

  const out: Prop[] = [];
  for (const property of properties) {
    if (property.type !== "ObjectProperty") return undefined;
    if (raw(property)["computed"] === true) return undefined;
    const keyNode = child(property, "key");
    const key = identName(keyNode) ?? stringLit(keyNode);
    const value = child(property, "value");
    if (key === undefined || value === undefined) return undefined;
    out.push({ key, value });
  }
  return out;
}

/** Every element of an ArrayExpression, or undefined if any element is a hole or a spread. */
export function arrayElements(node: AstNode | undefined): AstNode[] | undefined {
  if (node?.type !== "ArrayExpression") return undefined;
  const elements = childList(node, "elements");
  if (elements === undefined) return undefined;
  return elements.some((e) => e.type === "SpreadElement") ? undefined : elements;
}

// ---------------------------------------------------------------------------
// Statements, functions and expressions
// ---------------------------------------------------------------------------

export function expressionOf(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "ExpressionStatement") return undefined;
  return child(node, "expression");
}

export function awaited(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "AwaitExpression") return undefined;
  return child(node, "argument");
}

/** The returned expression, or undefined for a bare `return;` as well as a non-return node. */
export function returnArgument(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "ReturnStatement") return undefined;
  return child(node, "argument");
}

export function blockBody(node: AstNode | undefined): AstNode[] | undefined {
  if (node?.type !== "BlockStatement") return undefined;
  return childList(node, "body");
}

export type Arrow = {
  readonly params: readonly AstNode[];
  readonly body: AstNode;
  readonly isBlock: boolean;
};

export function arrowFn(node: AstNode | undefined): Arrow | undefined {
  if (node?.type !== "ArrowFunctionExpression") return undefined;
  const params = childList(node, "params");
  const body = child(node, "body");
  if (params === undefined || body === undefined) return undefined;
  return { params, body, isBlock: body.type === "BlockStatement" };
}

export type Conditional = {
  readonly test: AstNode;
  readonly consequent: AstNode;
  readonly alternate: AstNode;
};

export function conditional(node: AstNode | undefined): Conditional | undefined {
  if (node?.type !== "ConditionalExpression") return undefined;
  const test = child(node, "test");
  const consequent = child(node, "consequent");
  const alternate = child(node, "alternate");
  if (test === undefined || consequent === undefined || alternate === undefined) return undefined;
  return { test, consequent, alternate };
}

export type BinaryParts = {
  readonly operator: string;
  readonly left: AstNode;
  readonly right: AstNode;
};

function twoSided(node: AstNode | undefined, type: string): BinaryParts | undefined {
  if (node?.type !== type) return undefined;
  const operator = stringField(node, "operator");
  const left = child(node, "left");
  const right = child(node, "right");
  if (operator === undefined || left === undefined || right === undefined) return undefined;
  return { operator, left, right };
}

/** `a === b`, `a !== b`, … — never a LogicalExpression. */
export function binary(node: AstNode | undefined): BinaryParts | undefined {
  return twoSided(node, "BinaryExpression");
}

/** `a ?? b`, `a && b`, `a || b` — never a BinaryExpression. */
export function logical(node: AstNode | undefined): BinaryParts | undefined {
  return twoSided(node, "LogicalExpression");
}

export type Template = {
  /** Cooked strings, one more than `expressions`. */
  readonly quasis: readonly string[];
  readonly expressions: readonly AstNode[];
};

export function templateLiteral(node: AstNode | undefined): Template | undefined {
  if (node?.type !== "TemplateLiteral") return undefined;
  const quasiNodes = childList(node, "quasis");
  const expressions = childList(node, "expressions");
  if (quasiNodes === undefined || expressions === undefined) return undefined;
  const quasis: string[] = [];
  for (const q of quasiNodes) {
    const value = raw(q)["value"];
    if (typeof value !== "object" || value === null) return undefined;
    const cooked = (value as { cooked?: unknown }).cooked;
    if (typeof cooked !== "string") return undefined;
    quasis.push(cooked);
  }
  if (quasis.length !== expressions.length + 1) return undefined;
  return { quasis, expressions };
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export function importSource(node: AstNode | undefined): string | undefined {
  if (node?.type !== "ImportDeclaration") return undefined;
  return stringLit(child(node, "source"));
}

export type ImportName = {
  /** The exported name, e.g. "mcpJsonResult" in `mcpJsonResult as jsonResult`. */
  readonly imported: string;
  /** The local binding, equal to `imported` when there is no alias. */
  readonly local: string;
  readonly isType: boolean;
};

/** Every named specifier, or undefined if the clause has a default or namespace specifier. */
export function importNames(node: AstNode | undefined): ImportName[] | undefined {
  if (node?.type !== "ImportDeclaration") return undefined;
  const specifiers = childList(node, "specifiers");
  if (specifiers === undefined) return undefined;

  const out: ImportName[] = [];
  for (const specifier of specifiers) {
    if (specifier.type !== "ImportSpecifier") return undefined;
    const importedNode = child(specifier, "imported");
    const imported = identName(importedNode) ?? stringLit(importedNode);
    const local = identName(child(specifier, "local"));
    if (imported === undefined || local === undefined) return undefined;
    out.push({ imported, local, isType: raw(specifier)["importKind"] === "type" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Label-only readers — NEVER valid for a claim
// ---------------------------------------------------------------------------

/**
 * `blockers.ts` builds a histogram bucket label for a statement NOBODY claimed. It labels; it
 * never claims, so leniency is correct there and only there.
 *
 * Routing it through the guarded accessors above would collapse `obj[key]()` from
 * `method-call:.key` into a bare `statement:ExpressionStatement`, merging distinct buckets and
 * destroying the "near-misses stay visible" property the reach design is built on. These readers
 * exist so `blockers.ts` needs no cast of its own — an escape hatch there is one a recognizer
 * could copy.
 */
export function labelName(node: AstNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === "Identifier") return stringField(node, "name");
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    // Deliberately unguarded on `computed`: see this section's header.
    return identName(child(node, "property"));
  }
  return undefined;
}

/** The callee of a CallExpression, for labelling only. */
export function labelCallee(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "CallExpression") return undefined;
  return child(node, "callee");
}

/** The init of the FIRST declarator of any VariableDeclaration, `const` or not. */
export function labelFirstInit(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "VariableDeclaration") return undefined;
  const declarations = childList(node, "declarations");
  return declarations === undefined ? undefined : child(declarations[0], "init");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/scripts/derive-read.test.ts;    echo "test_exit=$?"
bunx tsc --noEmit;                            echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;         echo "biome_exit=$?"
```
Expected: all three `0`.

If `bun test --coverage` reports `read.ts` under its floor, add the missing accessor's test —
**do not** add a `coveragePathIgnorePatterns` entry.

- [ ] **Step 5: Commit**

```bash
git add scripts/_lib/derive/read.ts test/scripts/derive-read.test.ts
git commit -m "feat(derive): add guarded node accessors

Every AST field read goes through an accessor that checks computed, kind
and arity at the point of access, because the totality rule detects
statements nobody claimed and is blind to statements claimed wrongly — a
partial match is a wrong derivation reported as success, which is how the
same defect shipped eight times across five files.

numericValue is separate from numberLit: ArgSchema constrains sign on
none of min, max or default, and Babel parses -1 as a UnaryExpression, so
a strict reader would block a connector the generator can reproduce.

No generic getChildren: an untyped child list drops which slot a node came
from, which is the information the guards depend on.

Nothing consumes this yet; the retrofit is the next commit."
```

---

## Task 2: Make `AstNode` opaque and retrofit every reader

Turns the convention into a compile error, then fixes every resulting error. **Zero behaviour
change** — that is the acceptance bar, and it is checked three ways.

**Files:**
- Modify: `scripts/_lib/derive/ast.ts` (remove the index signature)
- Modify: `scripts/_lib/derive/blockers.ts`
- Modify: `scripts/_lib/derive/server/args.ts`
- Modify: `scripts/_lib/derive/server/env.ts`
- Modify: `scripts/_lib/derive/server/fetch-helper.ts`
- Modify: `scripts/_lib/derive/server/index.ts`
- Modify: `scripts/_lib/derive/server/path-template.ts`
- Modify: `scripts/_lib/derive/server/tools-hand.ts`

**Interfaces:**
- Consumes: every accessor from Task 1.
- Produces: no signature changes. `recognizeFrame`, `recognizeEnv`, `recognizeFetchHelper`,
  `recognizeTools`, `recognizeArgs`, `recognizePath` and `blockerFor` keep their exact current
  signatures and return values. Task 3 is what changes `recognizeFrame`.

- [ ] **Step 1: Record the pre-change baseline**

Run and **save the output to compare against in Step 6**:

```bash
bun run reach --nimbus-root C:/gitrep/Nimbus > /tmp/reach-before.txt 2>&1; echo "exit=$?"
cat /tmp/reach-before.txt
```

Expected: `REACH 4/94`, `no-frame` at 81, and the full blocker histogram.

- [ ] **Step 2: Remove the index signature**

Modify `scripts/_lib/derive/ast.ts` — replace the `AstNode` type with:

```ts
/**
 * A parsed node, carrying ONLY what the infrastructure needs: `claims.ts` compares byte ranges,
 * `blockers.ts` reads the type and line. Every other field is reached through `read.ts`.
 *
 * The absence of an index signature is the enforcement mechanism, not an oversight. With
 * `[key: string]: unknown`, `node["computed"]` and `node["kind"]` typecheck for any key and yield
 * `undefined` for absent ones — and whether that `undefined` rejects or matches depends on which
 * side of a comparison it lands on. Eight defects across five files came from exactly that.
 * Removing it makes an unguarded read a `tsc --noEmit` error.
 */
export type AstNode = {
  readonly type: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly loc?: { start: { line: number } };
};
```

- [ ] **Step 3: Run tsc to enumerate the work**

Run: `bunx tsc --noEmit`
Expected: FAIL, with one error per unguarded read across the seven modules. **This error list is
the task's checklist.**

- [ ] **Step 4: Retrofit `blockers.ts`**

Replace the body of `scripts/_lib/derive/blockers.ts` (keeping its existing docstrings) with:

```ts
import type { AstNode } from "./ast.ts";
import {
  expressionOf,
  functionName,
  importSource,
  labelCallee,
  labelFirstInit,
  labelName,
} from "./read.ts";

export type Blocker = { kind: string; detail: string; line: number };

const MAX_DETAIL = 100;

function calleeKind(callee: AstNode | undefined, prefix: string): string | undefined {
  if (callee === undefined) return undefined;
  const name = labelName(callee);
  if (name === undefined) return undefined;
  return callee.type === "Identifier" ? `${prefix}:${name}` : `method-call:.${name}`;
}

function kindOf(node: AstNode): string {
  if (node.type === "ImportDeclaration") {
    return `import-from:${importSource(node) ?? "?"}`;
  }
  if (node.type === "ExpressionStatement") {
    const kind = calleeKind(labelCallee(expressionOf(node)), "call");
    if (kind !== undefined) return kind;
  }
  if (node.type === "VariableDeclaration") {
    const kind = calleeKind(labelCallee(labelFirstInit(node)), "const-call");
    if (kind !== undefined) return kind;
  }
  const fn = functionName(node);
  if (fn !== undefined) return `function:${fn}`;
  return `statement:${node.type}`;
}
```

`expressionOf` and `functionName` are the strict accessors from Task 1, and they are strict enough
here: an ExpressionStatement always carries an `expression`, and a FunctionDeclaration's `id` is an
Identifier or absent. Only the callee read needs the lenient `labelName`. Keep `blockerFor` exactly
as it is — it reads only `start`, `end` and `loc`, all of which `AstNode` still carries.

- [ ] **Step 5: Retrofit the six recognizers, one file at a time**

For each file, replace raw index reads with the accessor that already encodes the same guard.
The mapping is mechanical:

| Current pattern | Replacement |
| --- | --- |
| `node.type !== "VariableDeclaration" \|\| node["kind"] !== "const"` + declarator digging | `constDecl(node)` |
| `callee["computed"] === true` + `(callee["property"] as AstNode)["name"]` | `memberName(callee)` |
| `(x as AstNode)["name"] !== "z"` | `!isIdent(x, "z")` |
| `init.type !== "CallExpression"` + callee name + `args.length !== n` | `callTo(init, name, n)` |
| `init?.type !== "NewExpression"` + ctor + arity | `newOf(init, ctor, n)` |
| `node["value"]` on a literal | `stringLit` / `numberLit` / `boolLit` |
| `arg.type !== "ObjectExpression"` + property loop + `computed` check | `objectProps(arg)` |
| `handlerNode.type !== "ArrowFunctionExpression"` + `["body"]` | `arrowFn(handlerNode)` |
| `node["expression"]` / `["argument"]` / `["body"]` | `expressionOf` / `awaited` / `blockBody` |

**Four sites need judgement, not mechanical substitution:**

1. `server/args.ts`'s `recognizeOne` walks a modifier chain with `current = callee["object"]`.
   Use `memberObject(callee)`, which carries the same computed guard the loop already has.
2. `server/args.ts` reads `modifier.args[0]?.["value"]` for `.min(n)` / `.max(n)`. Switch to
   `numericValue`, **not** `numberLit` — `ArgSchema` permits a negative bound and this is the site
   the `numericValue` accessor was written for. This is the one place in the retrofit where
   behaviour legitimately widens; add a test asserting `z.number().min(-5)` now recognizes.
3. `server/tools-hand.ts`'s `hoistDefaultLiteral` reads a `??` right-hand side. A numeric default
   may also be negative — switch to `numericValue` for the numeric branch, keeping `stringLit` and
   `boolLit` as they are, and add a test for `p.offset ?? -1`.
4. `server/index.ts`'s `getMcpServerInfo` reads two object properties positionally. `objectProps`
   returns them in source order, so `props.length !== 2`, `props[0].key === "name"` and
   `props[1].key === "version"` preserve the existing pinning exactly.

- [ ] **Step 6: Verify zero behaviour change**

```bash
bunx tsc --noEmit;                            echo "tsc_exit=$?"
bun test --coverage;                          echo "cov_exit=$?"
bunx biome check src/ test/ scripts/;         echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus > /tmp/reach-after.txt 2>&1
diff /tmp/reach-before.txt /tmp/reach-after.txt; echo "histogram_diff_exit=$?"
```

Expected: `tsc_exit=0`, `cov_exit=0`, `biome_exit=0`, `newrelic`/`datadog`/`grafana`/`sentry` all
`6/6`, and **`histogram_diff_exit=0`** — an identical report, byte for byte.

The two widened sites in Step 5 (negative `min`/`max` and a negative default) cannot move the
histogram, because no corpus connector currently reaches those recognizers with a negative literal.
If the diff is non-empty, **stop and find out why** rather than re-baselining: an unexplained
histogram move during a behaviour-preserving refactor is the exact failure this step exists to
catch.

- [ ] **Step 7: Commit**

```bash
git add scripts/_lib/derive/ test/scripts/
git commit -m "refactor(derive): make an unguarded node read a compile error

AstNode loses its index signature, so read.ts is the only module that can
reach a node's fields and tsc --noEmit enforces it. All seven readers are
retrofitted: six recognizers onto the guarded accessors, blockers.ts onto
the label-only group, where leniency is correct because it labels a
statement nobody claimed and never claims one itself.

Behaviour-preserving, checked three ways: the unit suite passes unchanged,
derive-round-trip.test.ts's two lists are untouched, and bun run reach
prints a byte-identical report.

Two sites legitimately widen. ArgSchema constrains sign on neither min/max
nor default, so .min(-5) and ?? -1 now recognize via numericValue where
they previously blocked. No corpus connector reaches either today, which
is why the histogram is unchanged."
```

---

## Task 3: Frame returns two statement lists

The structural change, still hand-rolled-only. Splitting it from the new frames means a
regression here cannot be confused with a bug in a new recognizer.

**Files:**
- Create: `scripts/_lib/derive/server/frame.ts`
- Modify: `scripts/_lib/derive/server/index.ts`
- Modify: `scripts/_lib/derive/index.ts`
- Modify: `test/scripts/derive-frame.test.ts`

**Interfaces:**
- Consumes: Task 1's accessors; `ClaimSet` from `claims.ts`.
- Produces:
  ```ts
  export type FrameStyle = "hand-rolled" | "read-only-kit" | "rest-kit";
  export type Frame = {
    readonly name: string;
    readonly style: FrameStyle;
    readonly toolStatements: readonly AstNode[];
    readonly verifyStatements: readonly AstNode[];
  };
  ```
  `recognizeFrame(statements, claims): Frame | undefined` keeps its name and parameters and
  changes its return type. Tasks 4 and 5 add branches to it.

- [ ] **Step 1: Write the failing test**

Modify `test/scripts/derive-frame.test.ts` — change the first assertion and add one:

```ts
  it("recovers the connector name and claims every frame statement", () => {
    const statements = parseModule(FRAME);
    const claims = createClaimSet();

    const frame = recognizeFrame(statements, claims);
    expect(frame?.name).toBe("newrelic");
    expect(frame?.style).toBe("hand-rolled");
    expect(claims.unclaimed(statements)).toEqual([]);
  });

  it("verifies and hands tools the top-level list for a hand-rolled module", () => {
    const statements = parseModule(FRAME);
    const frame = recognizeFrame(statements, createClaimSet());

    // Hand-rolled nests nothing, so both lists ARE the module's own statements. Asserted
    // rather than assumed: read-only-kit is the style where they differ, and a regression
    // that made them differ here would silently change what the totality rule walks.
    expect(frame?.toolStatements).toEqual(statements);
    expect(frame?.verifyStatements).toEqual(statements);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/scripts/derive-frame.test.ts`
Expected: FAIL — `frame?.style` is `undefined`, `toolStatements` does not exist.

- [ ] **Step 3: Create the shared frame type**

Create `scripts/_lib/derive/server/frame.ts`:

```ts
import type { AstNode } from "../ast.ts";

export type FrameStyle = "hand-rolled" | "read-only-kit" | "rest-kit";

/**
 * What frame recognition recovers, and the two statement lists it hands downstream.
 *
 * The two lists exist because claims are byte ranges and coverage is CONTAINMENT. That is
 * load-bearing elsewhere — it lets one matcher claim a multi-statement construct — and a hazard
 * here: read-only-kit nests its registrations inside
 * `await runReadOnlyMcpConnector("nimbus-x", (reg) => { ... })`, so claiming that statement would
 * cover every registration transitively, the totality rule would find nothing unclaimed, and a
 * connector whose tools were never recognized would derive successfully. A false `emits`, produced
 * by the very mechanism the totality rule exists to remove.
 *
 * So the read-only-kit branch removes EXACTLY ONE statement — the wrapper — from
 * `verifyStatements`, splices its callback body in, and never claims the wrapper. The wrapper is
 * still fully verified (the await, the callee, arity 2, the "nimbus-<name>" literal, a
 * single-parameter `(reg) =>` block arrow); it is simply never granted coverage. Every OTHER
 * top-level statement stays in `verifyStatements` and must still be claimed or become a blocker.
 *
 * For hand-rolled and rest-kit both lists are the module's own statement list.
 */
export type Frame = {
  readonly name: string;
  readonly style: FrameStyle;
  /** What the tool recognizers scan. */
  readonly toolStatements: readonly AstNode[];
  /** What the totality rule walks. */
  readonly verifyStatements: readonly AstNode[];
};
```

- [ ] **Step 4: Change `recognizeFrame`'s return**

In `scripts/_lib/derive/server/index.ts`, replace the `FrameFields` export with an import of
`Frame` from `./frame.ts`, and change the final return of `recognizeFrame` from

```ts
  return { name: connectorName };
```

to

```ts
  return {
    name: connectorName,
    style: "hand-rolled",
    toolStatements: statements,
    verifyStatements: statements,
  };
```

Leave every recognition check above it untouched.

- [ ] **Step 5: Use the lists in `deriveSpec`**

In `scripts/_lib/derive/index.ts`, replace the block from `const frame = recognizeFrame(...)`
through the `unclaimed` check with:

```ts
  const claims = createClaimSet();
  const frame = recognizeFrame(statements, claims);
  if (frame === undefined) {
    return blocked("no-frame", "src/server.ts is not a recognized frame");
  }

  const env = recognizeEnv(frame.verifyStatements, claims);
  const fetchHelper = recognizeFetchHelper(frame.verifyStatements, claims);
  const toolsResult = recognizeTools(frame.toolStatements, claims);

  // The totality rule walks frame.verifyStatements, NOT `statements`. For read-only-kit those
  // differ by exactly one statement — the wrapper, replaced by its callback body — which is what
  // stops the registrations inside it from inheriting coverage from a claim on the wrapper.
  const unclaimed = claims.unclaimed(frame.verifyStatements);
```

and change the spec object's `style` from the literal `"hand-rolled"` to `frame.style`.

Note `recognizeEnv` and `recognizeFetchHelper` now take `frame.verifyStatements`; for hand-rolled
that is the same array they received before, so nothing moves.

- [ ] **Step 6: Run the gates**

```bash
bun test --coverage;                          echo "cov_exit=$?"
bunx tsc --noEmit;                            echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;         echo "biome_exit=$?"
bun run reach --nimbus-root C:/gitrep/Nimbus > /tmp/reach-task3.txt 2>&1
diff /tmp/reach-after.txt /tmp/reach-task3.txt; echo "histogram_diff_exit=$?"
```

Expected: all `0`, including an unchanged histogram — this task adds no recognition.

- [ ] **Step 7: Commit**

```bash
git add scripts/_lib/derive/ test/scripts/derive-frame.test.ts
git commit -m "refactor(derive): frame returns tool and verify statement lists

recognizeFrame now returns a Frame carrying the style plus two statement
lists, and deriveSpec runs the totality rule over verifyStatements rather
than the module's top-level list.

The split exists for read-only-kit, landing next. Its registrations nest
inside the runReadOnlyMcpConnector callback, and because coverage is
containment, claiming that wrapper would cover every registration inside
it — the totality rule would find nothing unclaimed and a connector whose
tools were never recognized would derive. Splitting the lists now, while
both are still the same array, keeps a regression here distinguishable
from a bug in a new recognizer.

No recognition changes; the reach histogram is unchanged."
```

---

## Task 4: The read-only-kit frame

**Files:**
- Modify: `scripts/_lib/derive/server/index.ts` (add the branch)
- Create: `test/scripts/derive-frame-readonly.test.ts`
- Create: `fixtures/zzreadonly.spec.json`
- Modify: `fixtures/expectations.json`
- Modify: `test/scripts/derive-round-trip.test.ts`

**Interfaces:**
- Consumes: `Frame` from `./frame.ts`; Task 1's accessors.
- Produces: `recognizeFrame` returns `style: "read-only-kit"` with `toolStatements` set to the
  callback body and `verifyStatements` set to the top level minus the wrapper plus that body.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/derive-frame-readonly.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";
import { recognizeFrame } from "../../scripts/_lib/derive/server/index.ts";

/** A read-only-kit module: no McpServer, no transport, tools inside the wrapper callback. */
const READ_ONLY = [
  'import { z } from "zod";',
  'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
  "const BASE = \"https://example.test\";",
  'await runReadOnlyMcpConnector("nimbus-zzreadonly", (reg) => {',
  '  reg("a", "d", z.object({}), async () => jsonResult(await zzGet("/a")));',
  "});",
].join("\n");

describe("recognizeFrame, read-only-kit", () => {
  it("recovers the name and style", () => {
    const frame = recognizeFrame(parseModule(READ_ONLY), createClaimSet());
    expect(frame?.name).toBe("zzreadonly");
    expect(frame?.style).toBe("read-only-kit");
  });

  it("hands the callback body to the tool recognizers, not the wrapper", () => {
    const frame = recognizeFrame(parseModule(READ_ONLY), createClaimSet());
    expect(frame?.toolStatements).toHaveLength(1);
    expect(frame?.toolStatements[0]?.type).toBe("ExpressionStatement");
  });

  it("swaps exactly one statement: the wrapper, for its body", () => {
    const statements = parseModule(READ_ONLY);
    const frame = recognizeFrame(statements, createClaimSet());
    // 4 top-level statements; the wrapper is replaced by its single inner statement.
    expect(statements).toHaveLength(4);
    expect(frame?.verifyStatements).toHaveLength(4);
    // The base const is still there to be claimed or blocked — the swap is not a switch from
    // checking the module to checking the callback.
    expect(frame?.verifyStatements.some((s) => s.type === "VariableDeclaration")).toBe(true);
  });

  it("NEVER claims the wrapper, so a statement inside it stays visible", () => {
    // The containment hazard, asserted directly. If the frame claimed the wrapper, this
    // unrecognized statement would be covered transitively and the totality rule would pass
    // on a connector whose tools were never read — a false `emits`.
    const source = READ_ONLY.replace(
      "});",
      "  someUnrecognizedCall();\n});",
    );
    const statements = parseModule(source);
    const claims = createClaimSet();
    const frame = recognizeFrame(statements, claims);

    const unclaimed = claims.unclaimed(frame!.verifyStatements);
    expect(unclaimed.length).toBeGreaterThan(0);
  });

  it("rejects a wrapper whose callback is not a single-parameter arrow", () => {
    const source = READ_ONLY.replace("(reg) =>", "(reg, extra) =>");
    expect(recognizeFrame(parseModule(source), createClaimSet())).toBeUndefined();
  });

  it("rejects a non-awaited wrapper — the emitter always writes await", () => {
    const source = READ_ONLY.replace("await runReadOnly", "runReadOnly");
    expect(recognizeFrame(parseModule(source), createClaimSet())).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/scripts/derive-frame-readonly.test.ts`
Expected: FAIL — `recognizeFrame` returns `undefined` for every case (no read-only-kit branch).

- [ ] **Step 3: Add the branch**

In `scripts/_lib/derive/server/index.ts`, add above the existing hand-rolled logic in
`recognizeFrame`:

```ts
const RUN_READ_ONLY_SUFFIX = "/run-read-only-mcp-connector.ts";

/**
 * `await runReadOnlyMcpConnector("nimbus-<name>", (reg) => { ... });`
 *
 * Every part is pinned, because this statement is VERIFIED and never CLAIMED (see frame.ts):
 * the await, the callee identity, arity 2, the "nimbus-" prefixed string literal, and a
 * single-parameter arrow with a block body. Returning the body statements is what lets
 * deriveSpec swap this one statement for its children in verifyStatements.
 */
function readOnlyWrapper(node: AstNode): { name: string; body: AstNode[] } | undefined {
  const args = callTo(awaited(expressionOf(node)), "runReadOnlyMcpConnector", 2);
  if (args === undefined) return undefined;

  const full = stringLit(args[0]);
  if (full === undefined || !full.startsWith("nimbus-")) return undefined;

  const arrow = arrowFn(args[1]);
  if (arrow === undefined || arrow.params.length !== 1) return undefined;
  if (!isIdent(arrow.params[0], "reg")) return undefined;
  const body = blockBody(arrow.body);
  if (body === undefined) return undefined;

  return { name: full.slice("nimbus-".length), body };
}

function recognizeReadOnlyFrame(
  statements: readonly AstNode[],
  claims: ClaimSet,
): Frame | undefined {
  const runImport = statements.find((s) => importSource(s)?.endsWith(RUN_READ_ONLY_SUFFIX) === true);
  if (runImport === undefined) return undefined;

  let wrapper: AstNode | undefined;
  let recognized: { name: string; body: AstNode[] } | undefined;
  for (const statement of statements) {
    const match = readOnlyWrapper(statement);
    if (match === undefined) continue;
    // Two wrappers is a shape the emitter never writes; refuse rather than pick one.
    if (wrapper !== undefined) return undefined;
    wrapper = statement;
    recognized = match;
  }
  if (wrapper === undefined || recognized === undefined) return undefined;

  // Claim the frame's IMPORTS only. The wrapper is deliberately absent from this list: claiming
  // it would cover every registration inside it by containment.
  const frameImports = statements.filter((s) => isFrameImport(s) || s === runImport);
  claims.claim(frameImports, "frame");

  // Exactly one statement is swapped — the wrapper, for its body. Everything else stays.
  const verifyStatements = statements.flatMap((s) => (s === wrapper ? recognized.body : [s]));

  return {
    name: recognized.name,
    style: "read-only-kit",
    toolStatements: recognized.body,
    verifyStatements,
  };
}
```

Extend `FRAME_IMPORTS` / `isFrameImport` so the read-only-kit import set is covered: `"zod"`,
any `/mcp-tool-kit.ts`, any `/run-read-only-mcp-connector.ts`. **Do not** add
`/mcp-search-tool.ts` or `./search-filter.ts` — those belong to the search recognizer in plan 2,
and claiming them here would hide a search connector's real state.

Then dispatch at the top of `recognizeFrame`:

```ts
  const readOnly = recognizeReadOnlyFrame(statements, claims);
  if (readOnly !== undefined) return readOnly;
```

placed **before** the hand-rolled checks. A module cannot match both — read-only-kit has no
`McpServer` const — but ordering the cheap unambiguous discriminator first keeps the failure modes
separate.

- [ ] **Step 4: Run the frame test**

Run: `bun test test/scripts/derive-frame-readonly.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Add the `zzreadonly` fixture**

All eight existing `read-only-kit` fixtures declare a search tool, so without this fixture the new
frame ships with nothing proving it end-to-end — a gate that passes while asserting nothing.

Create `fixtures/zzreadonly.spec.json`. Read `fixtures/mercury.spec.json` for the field shape and
strip its search tool; the result must have `"style": "read-only-kit"`, at least one
`"impl": "rest"` tool, **no** `"impl": "search"` tool, no `query`, no `body`, and no non-`GET`
method. Consult the `cnc-spec-authoring` skill for the full field vocabulary. Every string is
hand-written here — no connector text.

Add `"zzreadonly": []` to `fixtures/expectations.json`, matching every other synthetic fixture.

- [ ] **Step 6: Move the fixture into `ROUND_TRIP`**

In `test/scripts/derive-round-trip.test.ts`, add `"zzreadonly"` to the `ROUND_TRIP` array. Leave
all eight search-bearing read-only-kit fixtures in `BLOCKED`, and update their reason string from
`"read-only-kit frame"` to `"search tool"` — the frame now recognizes them and the search
recognizer does not exist yet. Update the `BLOCKED` docstring to say so.

- [ ] **Step 7: Run the gates**

```bash
bun test --coverage;                          echo "cov_exit=$?"
bunx tsc --noEmit;                            echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;         echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus
```

Expected: gates `0`; `newrelic`/`datadog`/`grafana`/`sentry` still **6/6**; and `no-frame` drops by
roughly 60 in the histogram, replaced by whatever those connectors are really blocked on. The
headline `REACH` may not move at all — that is the expected result, not a failure.

- [ ] **Step 8: Commit**

```bash
git add scripts/_lib/derive/ test/scripts/ fixtures/zzreadonly.spec.json fixtures/expectations.json
git commit -m "feat(derive): recognize the read-only-kit frame

60 of the 94 corpus connectors use runReadOnlyMcpConnector, and all 60
reported no-frame — a harness gap, not a spec-language one: read-only-kit
has been in the style enum since Stage D.

The wrapper is verified and never claimed. Because coverage is
containment, a claim on it would cover every registration inside its
callback, so the totality rule would pass on a connector whose tools were
never recognized. Exactly one statement is swapped for its body in
verifyStatements; every other top-level statement still has to be claimed
or blocked.

zzreadonly is a synthetic search-free read-only-kit fixture. All eight
existing read-only-kit fixtures declare a search tool, so without it this
frame would ship with nothing proving it end-to-end. It keeps its value
after the search recognizer lands, because it is what distinguishes a
frame regression from a search one."
```

---

## Task 5: The rest-kit frame and `tools-rest`

**Files:**
- Modify: `scripts/_lib/derive/server/index.ts`
- Create: `scripts/_lib/derive/server/tools-rest.ts`
- Create: `test/scripts/derive-tools-rest.test.ts`
- Modify: `scripts/_lib/derive/index.ts`
- Modify: `test/scripts/derive-round-trip.test.ts`

**Interfaces:**
- Consumes: `Frame`, Task 1's accessors, `ArgFields`/`recognizeArgs` from `./args.ts`,
  `recognizePath` from `./path-template.ts`.
- Produces:
  ```ts
  export type RestToolsResult = {
    readonly registrar: string;
    readonly serviceLabel: string;
    readonly tokenEnv: string;
    readonly fetchLocal: string;
    readonly tools: ToolFields[];   // same ToolFields as tools-hand.ts
  };
  export function recognizeRestTools(
    statements: readonly AstNode[],
    claims: ClaimSet,
  ): RestToolsResult | undefined;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/scripts/derive-tools-rest.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";
import { recognizeRestTools } from "../../scripts/_lib/derive/server/tools-rest.ts";

const REST = [
  "const registerZzTool = makeRestToolRegistrar({",
  "  registrar: reg,",
  '  tokenEnv: "ZZ_TOKEN",',
  '  serviceLabel: "Zz",',
  "  fetch: zzFetch,",
  "});",
  "",
  "registerZzTool(",
  '  "zz_list",',
  '  "List things.",',
  "  z.object({}),",
  '  () => "/things",',
  ");",
].join("\n");

describe("recognizeRestTools", () => {
  it("recovers the factory's fields and the registrar name", () => {
    const statements = parseModule(REST);
    const result = recognizeRestTools(statements, createClaimSet());

    expect(result?.registrar).toBe("registerZzTool");
    expect(result?.serviceLabel).toBe("Zz");
    expect(result?.tokenEnv).toBe("ZZ_TOKEN");
    expect(result?.fetchLocal).toBe("zzFetch");
  });

  it("recovers each tool and claims both the factory and the calls", () => {
    const statements = parseModule(REST);
    const claims = createClaimSet();
    const result = recognizeRestTools(statements, claims);

    expect(result?.tools.map((t) => t.name)).toEqual(["zz_list"]);
    expect(claims.unclaimed(statements)).toEqual([]);
  });

  it("refuses the whole module when one call is not understood", () => {
    // All-or-nothing, matching recognizeTools: nine recognized tools and one bespoke handler
    // is not nine-tenths regenerable, it is blocked. Deriving the nine would emit a server.ts
    // missing a tool and misattribute the byte mismatch to formatting.
    const source = `${REST}\nregisterZzTool("bad", "d", z.object({}), someBespokeThing);`;
    expect(recognizeRestTools(parseModule(source), createClaimSet())).toBeUndefined();
  });

  it("rejects a let-bound factory — the emitter only writes const", () => {
    const source = REST.replace("const registerZzTool", "let registerZzTool");
    expect(recognizeRestTools(parseModule(source), createClaimSet())).toBeUndefined();
  });

  it("rejects a factory object with an unexpected key", () => {
    const source = REST.replace('  fetch: zzFetch,', '  fetch: zzFetch,\n  extra: 1,');
    expect(recognizeRestTools(parseModule(source), createClaimSet())).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/scripts/derive-tools-rest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `tools-rest.ts`**

Create `scripts/_lib/derive/server/tools-rest.ts`, inverting `renderRestKitTools` in
`src/emit/server/tools-rest.ts`. Read that file first — it is the specification. The contract:

- The factory const is `const <registrar> = makeRestToolRegistrar({ registrar: reg, tokenEnv,
  serviceLabel, fetch })` — **exactly** those four keys, in that order, `registrar` bound to the
  identifier `reg`, `tokenEnv` and `serviceLabel` string literals, `fetch` an identifier. Use
  `constDecl` + `callTo(init, "makeRestToolRegistrar", 1)` + `objectProps`. Reject any other key
  set: an extra key is a shape the emitter cannot produce.
- Each tool call is `<registrar>(name, description, schema, pathFn)` (arity 4) or
  `<registrar>(name, description, schema, pathFn, initFn)` (arity 5). Arity 5 carries a non-`GET`
  method and is **out of scope for this plan** — refuse it, so those connectors block visibly on a
  named blocker rather than deriving a `GET` that the real connector never had.
- `pathFn` has three in-scope forms: `() => <pathExpr>`, `(parsed) => <pathExpr>`, and
  `(parsed) => { <hoists> return <pathExpr>; }`. The query branch — a block whose body contains
  `const u = new URL(...)` — is **plan 2's**; refuse it.
- The path parameter is `parsed`, not `p` (`PARAM` in `tools-rest.ts`), so `recognizePath` is
  called with locals keyed the same way `tools-hand.ts` does but against that name.
- All-or-nothing: if any call fails, return `undefined` without claiming.

Claim the factory const and every tool call. Do **not** claim the `rest-tool-kit.ts` import; that
belongs to the frame (Step 4).

- [ ] **Step 4: Add the rest-kit frame branch**

In `recognizeFrame`, rest-kit is the hand-rolled five elements **plus** an import from
`/rest-tool-kit.ts`. The existing recognizer already reads the `McpServer` binding's name off the
node, so `const server = ...` needs no change. After the hand-rolled elements match, check for that
import: present → `style: "rest-kit"` and claim it too; absent → `style: "hand-rolled"`.

- [ ] **Step 5: Wire it into `deriveSpec`**

In `scripts/_lib/derive/index.ts`, branch on `frame.style === "rest-kit"` to call
`recognizeRestTools` instead of `recognizeTools`, and build the spec's `serviceLabel`, `env` and
`fetchHelper` from its result rather than from `recognizeEnv` / `recognizeFetchHelper` — rest-kit
emits neither env accessors nor a read helper (`emitServer` gates both on `isHandStyle`). The env
entry is a single one naming `tokenEnv` with `auth: "bearer"`.

- [ ] **Step 6: Move `zzstandalone` into `ROUND_TRIP`**

In `test/scripts/derive-round-trip.test.ts`, move `zzstandalone` from `BLOCKED` to `ROUND_TRIP`.
Leave `discord` and `google-meet` in `BLOCKED`, changing their reason to `"query parameters"`, and
`zzwriterest` to `"write body"`.

- [ ] **Step 7: Run the gates**

```bash
bun test --coverage;                          echo "cov_exit=$?"
bunx tsc --noEmit;                            echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;         echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus
```

Expected: gates `0`; the four fixtures **6/6**; `circleci`, `github-actions` and `pagerduty` no
longer blocked on `const-call:makeRestToolRegistrar` or `import-from:../../shared/rest-tool-kit.ts`.
The other seven rest-kit connectors stay blocked — see Task 6.

- [ ] **Step 8: Commit**

```bash
git add scripts/_lib/derive/ test/scripts/
git commit -m "feat(derive): recognize the rest-kit frame and its tool registrar

The frame is the hand-rolled five elements plus the rest-tool-kit import.
tools-rest inverts renderRestKitTools: the makeRestToolRegistrar factory
const, which is the sole source of serviceLabel, the auth env var and the
fetch helper's local name, plus each registrar call.

Arity-5 calls (a non-GET method) and the query branch are refused rather
than partially read — both are plan 2's, and a partial read would derive a
GET the real connector never had.

Three of the ten rest-kit connectors clear this; the other seven are held
by the registrar and transport-tail idiom variance, named in the next
commit."
```

---

## Task 6: Split `no-frame` into named blockers

81 connectors in one bucket is a wall, not a finding. The frame recognizer already tests each
element separately, so naming the failure costs nothing.

**Files:**
- Modify: `scripts/_lib/derive/server/index.ts`
- Modify: `scripts/_lib/derive/index.ts`
- Modify: `test/scripts/derive-frame.test.ts`

**Interfaces:**
- Produces: `recognizeFrame` gains a sibling
  ```ts
  export function frameFailureKind(statements: readonly AstNode[]): string;
  ```
  returning one of `frame:no-kit-import`, `frame:no-mcp-server`, `frame:registrar-not-inlined`,
  `frame:no-registrar`, `frame:tail-inlined-transport`, `frame:no-transport`, `frame:no-connect`,
  or `frame:unrecognized`.

- [ ] **Step 1: Write the failing test**

Add to `test/scripts/derive-frame.test.ts`:

```ts
import { frameFailureKind } from "../../scripts/_lib/derive/server/index.ts";

describe("frameFailureKind", () => {
  it("names the two-line registrar idiom (discord, github)", () => {
    const source = FRAME.replace(
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      [
        "const registerSimpleTool = createRegisterSimpleTool(mcp);",
        "const reg = createZodToolRegistrar(registerSimpleTool);",
      ].join("\n"),
    );
    expect(frameFailureKind(parseModule(source))).toBe("frame:registrar-not-inlined");
  });

  it("names the inlined transport tail (gmail, onedrive, outlook, google-*)", () => {
    const source = FRAME.replace(
      "const transport = new StdioServerTransport();\nawait mcp.connect(transport);",
      "await mcp.connect(new StdioServerTransport());",
    );
    expect(frameFailureKind(parseModule(source))).toBe("frame:tail-inlined-transport");
  });

  it("names a missing kit import", () => {
    expect(frameFailureKind(parseModule("const x = 1;"))).toBe("frame:no-kit-import");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/scripts/derive-frame.test.ts`
Expected: FAIL — `frameFailureKind` is not exported.

- [ ] **Step 3: Implement `frameFailureKind`**

Add to `scripts/_lib/derive/server/index.ts` a function that re-runs the same five element checks
in order and returns the name of the first that fails, with two specific near-miss detections:

- **`frame:registrar-not-inlined`** — a `const <x> = createZodToolRegistrar(<identifier>)` exists
  where the argument is a bare identifier rather than the inlined
  `createRegisterSimpleTool(<mcpVar>)` call.
- **`frame:tail-inlined-transport`** — an `await <mcpVar>.connect(new StdioServerTransport())`
  exists, i.e. the transport is constructed inside the connect call rather than bound to a const.

Both are shapes `src/emit/server/index.ts` cannot produce, so **neither is accepted** — this only
names them. `docs/ROADMAP.md` records both under *Wiring and tail idiom*; the corpus split is
`discord`/`github` on the first and `gmail`/`google-meet`/`google-photos`/`onedrive`/`outlook` on
the second.

- [ ] **Step 4: Use it in `deriveSpec`**

In `scripts/_lib/derive/index.ts`:

```ts
  const frame = recognizeFrame(statements, claims);
  if (frame === undefined) {
    return blocked(frameFailureKind(statements), "src/server.ts is not a recognized frame");
  }
```

- [ ] **Step 5: Run the gates**

```bash
bun test --coverage;                          echo "cov_exit=$?"
bunx tsc --noEmit;                            echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;         echo "biome_exit=$?"
bun run reach --nimbus-root C:/gitrep/Nimbus
```

Expected: gates `0`; the histogram shows `frame:registrar-not-inlined` at 2 and
`frame:tail-inlined-transport` at 5, and no remaining bare `no-frame` bucket.

- [ ] **Step 6: Commit**

```bash
git add scripts/_lib/derive/ test/scripts/derive-frame.test.ts
git commit -m "feat(reach): name the frame element that failed

no-frame held 81 connectors in one bucket, which is a wall rather than a
finding — it is why the seven-rest-kit question was expensive enough to
defer. The frame recognizer already tests each element separately, so
naming the first failure costs nothing at claim time.

Two near-misses get their own buckets, both documented in ROADMAP.md under
Wiring and tail idiom: discord and github bind the inner registrar call to
its own const; gmail, google-meet, google-photos, onedrive and outlook
inline the transport into connect(). Neither is accepted — both are shapes
the emitter cannot produce, so claiming them would be a wrong claim — but
a documented limitation now gets counted instead of hiding inside a bucket
indistinguishable from a genuine spec-language gap."
```

---

## Task 7: Re-baseline and update the roadmap

**Files:**
- Regenerate: `fixtures/reach-baseline.json`
- Modify: `docs/ROADMAP.md`
- Modify: `docs/superpowers/specs/2026-08-03-from-connector-reach-design.md`

- [ ] **Step 1: Confirm the checkout is clean and re-baseline**

```bash
git -C C:/gitrep/Nimbus status --porcelain -- packages/mcp-connectors; echo "dirty_exit=$?"
bun run reach:baseline --nimbus-root C:/gitrep/Nimbus; echo "baseline_exit=$?"
```

The first command must print nothing. `reach:baseline` refuses a dirty checkout, because a
baseline filed against a SHA whose tree differs is a false green with a paper trail.

- [ ] **Step 2: Verify the baseline gate passes**

```bash
bun run reach --nimbus-root C:/gitrep/Nimbus --baseline; echo "baseline_gate_exit=$?"
```
Expected: `0`.

**Never edit `fixtures/reach-baseline.json` by hand to make a run pass** — it is rewritten by
`reach:baseline` when the measurement moves, and by nothing else.

- [ ] **Step 3: Update `docs/ROADMAP.md`**

- Stage E's multi-file item: replace the hard-coded `**16**` with the measured blocker name now
  that `import-from:./tools.ts` is a real bucket, or point at `bun run reach` — the file's own rule
  is that restated live numbers go stale silently.
- Stage E's CLI-backed item: same treatment for the `**5**`.
- *Shape variance the emitter models one way* → *Wiring and tail idiom*: replace "roughly half …
  and half" with the exact split, now enumerated rather than estimated — `discord` and `github` on
  the registrar axis; `gmail`, `google-meet`, `google-photos`, `onedrive`, `outlook` on the tail
  axis; `circleci`, `github-actions`, `pagerduty` matching the emitter on both.
- *Measuring reach*: note that the corpus-wide question is now asked across all three frame styles.

- [ ] **Step 4: Supersede the reach design's deferral note**

In `docs/superpowers/specs/2026-08-03-from-connector-reach-design.md`, add a line under its
*Not built — plan 2's territory* paragraph pointing at
`2026-08-04-completing-the-recognizer-set-design.md`. **Do not rewrite the paragraph** — it is a
historical record of what that plan built.

- [ ] **Step 5: Run every gate one final time**

```bash
bun test --coverage;                                          echo "cov_exit=$?"
bunx tsc --noEmit;                                            echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;                         echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus --baseline;      echo "reach_exit=$?"
bun run wiring:conformance --nimbus-root C:/gitrep/Nimbus;    echo "wiring_exit=$?"
```

Expected: every exit code `0`, and `newrelic`, `datadog`, `grafana`, `sentry` each **6/6**.

- [ ] **Step 6: Commit**

```bash
git add fixtures/reach-baseline.json docs/
git commit -m "chore(reach): re-baseline and record the measured frame split

The corpus measurement moved because the deriver reads two more frame
styles, so the baseline is rewritten by reach:baseline against the same
packages/mcp-connectors tree. Never edited by hand.

ROADMAP.md's Wiring and tail idiom gains the exact connectors on each side
of both axes, replacing an estimate with an enumeration, and Stage E's
hand counts give way to the buckets that now measure them."
```

---

## Self-Review

**Spec coverage.** Design §1 → Tasks 1–2. §2 → Tasks 3–4. §3 → Tasks 5–6 (including the diagnosed
idiom variance and the `no-frame` split). §6's commit table rows 1–3 → Tasks 1–6; row 7's
re-baseline and docs → Task 7. §4 (search, search-filter) and §5 (query, body) are **deliberately
deferred to plan 2**, stated in *Scope of this plan* with the reason. §7 (consequences for other
documents) → Task 7 Steps 3–4.

**Known gap, stated rather than hidden:** design §6's commit 6b (client-credentials, `zzwrite`) is
in neither plan. It is an `env.ts` exclusion covering 4 corpus connectors and was marked optional
in the design; it should be picked up in plan 2 or dropped explicitly, not left to drift.

**Type consistency.** `Frame` is introduced in Task 3 (`frame.ts`) and consumed unchanged in Tasks
4–5. `ToolFields` is reused from `tools-hand.ts` by `tools-rest.ts` rather than redeclared.
`recognizeFrame` keeps its `(statements, claims)` parameters throughout; only its return type
changes, and only in Task 3. `numericValue` is introduced in Task 1 and consumed at the three sites
named in Task 2 Step 5.

**Placeholder scan.** Task 4 Step 5 (`zzreadonly`) and Task 5 Step 3 (`tools-rest.ts`) give
contracts and constraints rather than complete literal content — the fixture because its field
values must be hand-authored to satisfy the licensing constraint, and `tools-rest.ts` because it
inverts an emitter function whose source is in the repo and is the authority. Both name the exact
file to read, every shape to accept, and every shape to refuse. Nothing else in the plan defers
content.
