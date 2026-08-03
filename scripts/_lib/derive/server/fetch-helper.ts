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
