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
