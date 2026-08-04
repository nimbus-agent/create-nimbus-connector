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
