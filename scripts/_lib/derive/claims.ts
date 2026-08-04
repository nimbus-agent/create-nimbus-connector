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
