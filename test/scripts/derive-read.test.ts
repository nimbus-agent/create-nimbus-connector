import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import {
  arrayElements,
  arrowFn,
  awaited,
  binary,
  blockBody,
  boolLit,
  calleeOf,
  callTo,
  callToAny,
  conditional,
  constDecl,
  expressionOf,
  functionName,
  identName,
  importNames,
  importSource,
  labelCallee,
  labelFirstInit,
  labelName,
  logical,
  memberName,
  memberObject,
  memberOn,
  methodCallTo,
  newOf,
  numberLit,
  numericValue,
  objectProps,
  returnArgument,
  stringLit,
  templateLiteral,
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
    expect(methodCallTo(initOf("mcp.connect(transport)"), "mcp", "connect", 1)).toHaveLength(1);
  });

  it("rejects a computed property — u[set](a, b) is not u.set(a, b)", () => {
    expect(methodCallTo(initOf("u[set](a, b)"), "u", "set", 2)).toBeUndefined();
  });

  it("rejects a different receiver", () => {
    expect(methodCallTo(initOf("v.connect(t)"), "mcp", "connect", 1)).toBeUndefined();
  });

  it("rejects a wrong arity", () => {
    expect(methodCallTo(initOf("mcp.connect(a, b)"), "mcp", "connect", 1)).toBeUndefined();
  });

  /**
   * `u.searchParams.set(k, v)` is a TWO-level chain: the callee's object is itself a
   * MemberExpression, not an Identifier. methodCallTo models a ONE-level receiver and must
   * refuse it — widening the receiver check to also accept the inner member's property name
   * would make `methodCallTo(x, "searchParams", "set", 2)` match `anything.searchParams.set(...)`,
   * dropping the identity of `u` entirely. That is a matcher validating part of a shape and
   * claiming the whole of it: the exact defect class this module exists to make impossible,
   * reintroduced into the module built to prevent it.
   *
   * The query recognizer that needs this shape composes it from the strict primitives instead —
   * asserted below so the composition is a tested route rather than a hopeful one.
   */
  it("refuses a two-level chain, which composes from the primitives instead", () => {
    const call = initOf("u.searchParams.set(k, v)");
    expect(methodCallTo(call, "searchParams", "set", 2)).toBeUndefined();
    expect(methodCallTo(call, "u", "set", 2)).toBeUndefined();

    const callee = calleeOf(call);
    expect(memberName(callee)).toBe("set");
    const inner = memberObject(callee);
    expect(memberName(inner)).toBe("searchParams");
    expect(identName(memberObject(inner))).toBe("u");
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

/**
 * The Step 1 fixtures above exercise every accessor `blockers.ts`, `args.ts` and the query
 * recognizer already reach through. These accessors are exports Tasks 2–6 are declared to use
 * but nothing here reaches yet — covered directly so the per-file floor in `bunfig.toml`
 * measures this module honestly rather than needing a `coveragePathIgnorePatterns` entry.
 */
describe("accessors not yet reached by a recognizer", () => {
  it("memberOn reads a member only when the receiver identifier matches", () => {
    expect(memberOn(initOf("p.limit"), "p")).toBe("limit");
    expect(memberOn(initOf("p.limit"), "q")).toBeUndefined();
  });

  it("functionName reads a declaration's name, and rejects a non-declaration", () => {
    expect(functionName(only("function foo() {}"))).toBe("foo");
    expect(functionName(only("const foo = () => {};"))).toBeUndefined();
  });

  it("callToAny matches any arity by callee identity alone", () => {
    expect(callToAny(initOf("f(1, 2, 3)"), "f")).toHaveLength(3);
    expect(callToAny(initOf("g(1, 2, 3)"), "f")).toBeUndefined();
  });

  it("arrayElements reads elements, and rejects a spread", () => {
    expect(arrayElements(initOf("[1, 2, 3]"))).toHaveLength(3);
    expect(arrayElements(initOf("[...rest]"))).toBeUndefined();
  });

  it("binary reads operator and sides, never a LogicalExpression", () => {
    const b = binary(initOf("a === b"));
    expect(b?.operator).toBe("===");
    expect(identName(b?.left)).toBe("a");
    expect(identName(b?.right)).toBe("b");
    expect(binary(initOf("a ?? b"))).toBeUndefined();
  });

  it("logical reads operator and sides, never a BinaryExpression", () => {
    const l = logical(initOf("a ?? b"));
    expect(l?.operator).toBe("??");
    expect(logical(initOf("a === b"))).toBeUndefined();
  });

  it("templateLiteral reads cooked quasis and expressions in step", () => {
    const t = templateLiteral(initOf("`a${b}c`"));
    expect(t?.quasis).toEqual(["a", "c"]);
    expect(t?.expressions).toHaveLength(1);
    expect(identName(t?.expressions[0])).toBe("b");
  });

  it("importNames reads every named specifier, aliased or not", () => {
    const names = importNames(only('import { a, b as c } from "./x.ts";'));
    expect(names).toEqual([
      { imported: "a", local: "a", isType: false },
      { imported: "b", local: "c", isType: false },
    ]);
  });

  it("importNames rejects a default or namespace specifier", () => {
    expect(importNames(only('import a from "./x.ts";'))).toBeUndefined();
  });

  it("labelName reads an identifier or a member's property, unguarded on computed", () => {
    expect(labelName(initOf("a"))).toBe("a");
    expect(labelName(initOf("p[key]"))).toBe("key");
    expect(labelName(initOf("1"))).toBeUndefined();
  });

  it("labelCallee reads a call's callee for labelling only", () => {
    expect(identName(labelCallee(initOf("f(1)")))).toBe("f");
  });

  it("labelFirstInit reads the first declarator's init on let, not just const", () => {
    expect(numberLit(labelFirstInit(only("let a = 1, b = 2;")))).toBe(1);
    expect(labelFirstInit(only("f();"))).toBeUndefined();
  });
});
