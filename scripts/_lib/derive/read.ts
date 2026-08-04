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

export type RegExpParts = { readonly pattern: string; readonly flags: string };

/** A regex literal's pattern and flags, e.g. `/\/$/` -> `{ pattern: "\\/$", flags: "" }`. */
export function regExpLit(node: AstNode | undefined): RegExpParts | undefined {
  if (node?.type !== "RegExpLiteral") return undefined;
  const pattern = stringField(node, "pattern");
  const flags = stringField(node, "flags");
  if (pattern === undefined || flags === undefined) return undefined;
  return { pattern, flags };
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

/**
 * `<anything>?.<name>`, rejecting computed — the optional-chain analogue of `memberName`.
 *
 * `x?.trim()` parses its `?.trim` step as an OptionalMemberExpression, a node type distinct from
 * the plain MemberExpression `memberName` reads; `env.ts`'s `process.env[...]?.trim()` is the one
 * shape in the corpus that needs it. Callers compose this with `memberName` (the two node types
 * are mutually exclusive) rather than widening `memberName` itself onto every other call site.
 */
export function optionalMemberName(node: AstNode | undefined): string | undefined {
  if (node?.type !== "OptionalMemberExpression") return undefined;
  if (raw(node)["computed"] === true) return undefined;
  return identName(child(node, "property"));
}

/** The receiver of a non-computed OptionalMemberExpression — see `optionalMemberName`. */
export function optionalMemberObject(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "OptionalMemberExpression") return undefined;
  if (raw(node)["computed"] === true) return undefined;
  return child(node, "object");
}

/**
 * `<receiver>[<literal>]` -> its receiver and its literal key node, when the member IS computed.
 *
 * The inverse case from `memberName`/`memberObject`: those two exist to reject a computed member
 * because an unguarded read of its `property` would name things after the KEY VARIABLE rather
 * than a property. Here the key is exactly what is wanted — `process.env["VAR"]` is written
 * computed on purpose — so the hazard does not apply and the key node is handed back for the
 * caller to resolve with `stringLit` (never `identName`, which would reintroduce it).
 */
export function computedMember(
  node: AstNode | undefined,
): { object: AstNode; key: AstNode } | undefined {
  if (node?.type !== "MemberExpression") return undefined;
  if (raw(node)["computed"] !== true) return undefined;
  const object = child(node, "object");
  const key = child(node, "property");
  if (object === undefined || key === undefined) return undefined;
  return { object, key };
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

/** A FunctionDeclaration's parameter list. */
export function functionParams(node: AstNode | undefined): AstNode[] | undefined {
  if (node?.type !== "FunctionDeclaration") return undefined;
  return childList(node, "params");
}

/** A FunctionDeclaration's body statements — never an expression body, unlike an arrow. */
export function functionBody(node: AstNode | undefined): AstNode[] | undefined {
  if (node?.type !== "FunctionDeclaration") return undefined;
  return blockBody(child(node, "body"));
}

/** Whether a FunctionDeclaration is `async`. */
export function isAsyncFunction(node: AstNode | undefined): boolean {
  if (node?.type !== "FunctionDeclaration") return false;
  return raw(node)["async"] === true;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** The arguments of a plain CallExpression — never an OptionalCallExpression. */
export function callArgs(node: AstNode | undefined): AstNode[] | undefined {
  if (node?.type !== "CallExpression") return undefined;
  return childList(node, "arguments");
}

/**
 * The callee of a plain CallExpression, for chains `methodCallTo` deliberately does not model.
 *
 * `methodCallTo` handles a ONE-level receiver (`mcp.connect(t)`). A two-level chain
 * (`u.searchParams.set(k, v)`) has a MemberExpression where that receiver would be, and widening
 * `methodCallTo` to accept it would drop the identity of `u` — a matcher claiming a shape it only
 * partly checked. A caller that needs the two-level form composes it instead:
 * `memberName(calleeOf(c))` -> "set", `memberName(memberObject(calleeOf(c)))` -> "searchParams",
 * `identName(memberObject(memberObject(calleeOf(c))))` -> "u". Every step keeps its own guard.
 */
export function calleeOf(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "CallExpression") return undefined;
  return child(node, "callee");
}

/**
 * The callee of an OptionalCallExpression — the `?.()` step of a chain like `x?.trim()`.
 *
 * `?.` on a call produces this distinct node type rather than a plain CallExpression, the same
 * split `optionalMemberName` documents for member access.
 */
export function optionalCallCallee(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "OptionalCallExpression") return undefined;
  return child(node, "callee");
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
 * Every property of an ObjectExpression, unfiltered — a SpreadElement, a computed key or any
 * other shape included as-is rather than disqualifying the whole list.
 *
 * `objectProps` is a PARSE: any property it cannot resolve rejects the entire object, which is
 * right for a fixed-shape literal read wholesale. Some callers instead SEARCH a properties list
 * for one named entry, tolerating and skipping whatever they are not looking for (a `signal:`
 * option alongside `headers:`, a spread that carries no readable key at all) — `objectProps`
 * would refuse the whole options object over an unrelated property it does not understand. This
 * pairs with `objectProperty` for that search.
 */
export function objectExpressionProperties(node: AstNode | undefined): AstNode[] | undefined {
  if (node?.type !== "ObjectExpression") return undefined;
  return childList(node, "properties");
}

/**
 * One ObjectProperty's key and value nodes, exactly as written.
 *
 * Unlike `objectProps`, this does not require the key to resolve to a name and does not reject a
 * computed key — a caller using this (rather than `objectProps`) is discriminating the key node's
 * own shape itself, e.g. requiring specifically an Identifier and refusing a same-named
 * StringLiteral, a distinction `objectProps`'s `identName ?? stringLit` merging cannot preserve.
 */
export function objectProperty(
  node: AstNode | undefined,
): { key: AstNode; value: AstNode } | undefined {
  if (node?.type !== "ObjectProperty") return undefined;
  const key = child(node, "key");
  const value = child(node, "value");
  if (key === undefined || value === undefined) return undefined;
  return { key, value };
}

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

export type IfParts = {
  readonly test: AstNode;
  readonly consequent: AstNode;
  readonly alternate: AstNode | undefined;
};

/** An `if` statement's test, consequent and (possibly absent) alternate. */
export function ifStatement(node: AstNode | undefined): IfParts | undefined {
  if (node?.type !== "IfStatement") return undefined;
  const test = child(node, "test");
  const consequent = child(node, "consequent");
  if (test === undefined || consequent === undefined) return undefined;
  return { test, consequent, alternate: child(node, "alternate") };
}

/** A `throw <argument>;` statement's argument. */
export function throwArgument(node: AstNode | undefined): AstNode | undefined {
  if (node?.type !== "ThrowStatement") return undefined;
  return child(node, "argument");
}

export type UnaryParts = { readonly operator: string; readonly argument: AstNode };

/** `!x`, `-x`, `+x`, … — operator and operand. See `numericValue` for the signed-literal case. */
export function unary(node: AstNode | undefined): UnaryParts | undefined {
  if (node?.type !== "UnaryExpression") return undefined;
  const operator = stringField(node, "operator");
  const argument = child(node, "argument");
  if (operator === undefined || argument === undefined) return undefined;
  return { operator, argument };
}

/** `<expression> as <type>` -> the expression and the type annotation node's own `type`. */
export function asExpression(
  node: AstNode | undefined,
): { expression: AstNode; typeAnnotationType: string } | undefined {
  if (node?.type !== "TSAsExpression") return undefined;
  const expression = child(node, "expression");
  const typeAnnotation = child(node, "typeAnnotation");
  if (expression === undefined || typeAnnotation === undefined) return undefined;
  return { expression, typeAnnotationType: typeAnnotation.type };
}

export type TryParts = {
  readonly block: AstNode;
  readonly handler: AstNode | undefined;
  readonly finalizer: AstNode | undefined;
};

/** `try { <block> } catch (<handler.param>) { <handler.body> } finally { <finalizer> }`. */
export function tryStatement(node: AstNode | undefined): TryParts | undefined {
  if (node?.type !== "TryStatement") return undefined;
  const block = child(node, "block");
  if (block === undefined) return undefined;
  return { block, handler: child(node, "handler"), finalizer: child(node, "finalizer") };
}

export type CatchParts = { readonly param: AstNode | undefined; readonly body: AstNode };

/** A `catch` clause's optional binding and its body. */
export function catchClause(node: AstNode | undefined): CatchParts | undefined {
  if (node?.type !== "CatchClause") return undefined;
  const body = child(node, "body");
  if (body === undefined) return undefined;
  return { param: child(node, "param"), body };
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
