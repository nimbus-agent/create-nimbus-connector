import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";

export type FetchHelperFields = {
  local: string;
  base: string;
  serviceLabel: string;
  inlineHeaders?: Record<string, string>;
  headers?: string;
  normalizeLeadingSlash?: true;
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

/**
 * Reconstruct the full base URL from the template literal, handling env variable references.
 * For `` `https://${siteHost()}${path}` ``, extracts "https://${env.siteHost}".
 * The last expression is the path variable and is excluded from the base.
 */
function reconstructBase(template: AstNode): string | undefined {
  if (template.type !== "TemplateLiteral") return undefined;
  const quasis = (template["quasis"] as AstNode[]) ?? [];
  const expressions = (template["expressions"] as AstNode[]) ?? [];

  // The last expression should be the path variable (Identifier: path or pathPart).
  // Drop it and the trailing quasi.
  if (expressions.length === 0 || quasis.length === 0) return undefined;

  const lastExpr = expressions[expressions.length - 1];
  if (lastExpr?.type !== "Identifier") return undefined;

  // Reconstruct: concatenate quasis[0..n-2] and expressions[0..n-2],
  // then the first n-1 quasis' cooked values.
  const parts: string[] = [];
  const numToUse = expressions.length - 1;

  for (let i = 0; i <= numToUse; i++) {
    const quasi = quasis[i];
    const cooked = (quasi?.["value"] as { cooked?: string } | undefined)?.cooked;
    if (cooked === undefined) return undefined;
    parts.push(cooked);

    if (i < numToUse) {
      const expr = expressions[i];
      if (expr?.type === "CallExpression") {
        const callee = expr["callee"] as AstNode;
        if (callee.type !== "Identifier") return undefined;
        const name = String(callee["name"] ?? "");
        parts.push(`\${env.${name}}`);
      } else {
        return undefined;
      }
    }
  }

  return parts.join("");
}

function headerValue(value: AstNode): string | undefined {
  if (typeof value["value"] === "string") return value["value"];
  if (value.type === "CallExpression") {
    const callee = value["callee"] as AstNode;
    if (callee.type === "Identifier") return `\${env.${String(callee["name"])}}`;
  }
  return undefined;
}

/**
 * Extract inline headers from an ObjectExpression headers object.
 * Returns the headers object or undefined if not inline form.
 */
function inlineHeadersObject(fetchCall: AstNode): Record<string, string> | undefined {
  const options = (fetchCall["arguments"] as AstNode[])[1];
  const properties = (options?.["properties"] as AstNode[] | undefined) ?? [];
  const headers = properties.find((p) => (p["key"] as AstNode)["name"] === "headers");
  const headersValue = headers?.["value"] as AstNode | undefined;

  // Must be an ObjectExpression for inline headers
  if (headersValue?.type !== "ObjectExpression") return undefined;

  const entries = (headersValue["properties"] as AstNode[]) ?? [];
  if (entries.length === 0) return undefined;

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

/**
 * Extract the headers accessor name from the CallExpression form.
 * For `{ headers: headers() }` or `{ headers: authHeaders() }`, returns "headers" or "authHeaders".
 */
function headersAccessor(fetchCall: AstNode): string | undefined {
  const options = (fetchCall["arguments"] as AstNode[])[1];
  const properties = (options?.["properties"] as AstNode[] | undefined) ?? [];
  const headers = properties.find((p) => (p["key"] as AstNode)["name"] === "headers");
  const headersValue = headers?.["value"] as AstNode | undefined;

  // Must be a zero-argument CallExpression with Identifier callee
  if (headersValue?.type !== "CallExpression") return undefined;
  const args = (headersValue["arguments"] as AstNode[]) ?? [];
  if (args.length !== 0) return undefined;

  const callee = headersValue["callee"] as AstNode;
  if (callee.type !== "Identifier") return undefined;

  return String(callee["name"] ?? "");
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
 * Count fetch() calls in the function body. Must be exactly 1 to unambiguously identify
 * the real fetch helper (not a decoy with its own headers object).
 */
function countFetchCalls(fn: AstNode): number {
  let count = 0;
  walk(fn, (n) => {
    if (n.type === "CallExpression" && (n["callee"] as AstNode)["name"] === "fetch") {
      count++;
    }
  });
  return count;
}

/**
 * Detect the normalizeLeadingSlash pattern:
 * const pathPart = path.startsWith("/") ? path : `/${path}`;
 */
function hasNormalizeLeadingSlash(fn: AstNode): boolean {
  const statements = ((fn["body"] as AstNode | undefined)?.["body"] as AstNode[] | undefined) ?? [];
  for (const stmt of statements) {
    if (stmt.type !== "VariableDeclaration") continue;
    const decl = (stmt["declarations"] as AstNode[])?.[0];
    if (!decl) continue;
    const id = decl["id"] as AstNode;
    if ((id["name"] as string) !== "pathPart") continue;
    // Found the pathPart declaration, assume normalizeLeadingSlash is present
    return true;
  }
  return false;
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

    // Fix for correlation defect: count fetch() calls. If != 1, reject.
    if (countFetchCalls(s) !== 1) continue;

    const fetchCall = find(
      s,
      (n) => n.type === "CallExpression" && (n["callee"] as AstNode)["name"] === "fetch",
    );
    if (fetchCall === undefined) continue;

    const url = (fetchCall["arguments"] as AstNode[])[0];
    const base = url === undefined ? undefined : reconstructBase(url);
    const inlineHeadersObj = inlineHeadersObject(fetchCall);
    const headersAccessorName = headersAccessor(fetchCall);
    const serviceLabel = serviceLabelFrom(s);
    const local = String((s["id"] as AstNode | undefined)?.["name"] ?? "");

    if (base === undefined || serviceLabel === undefined || local === "") continue;

    // Either inline headers or accessor, but not both
    if (
      (inlineHeadersObj !== undefined && headersAccessorName !== undefined) ||
      (inlineHeadersObj === undefined && headersAccessorName === undefined)
    ) {
      continue;
    }

    const normalizeLeadingSlash = hasNormalizeLeadingSlash(s) ? true : undefined;

    claims.claim(s, "fetch-helper");
    return {
      local,
      base,
      serviceLabel,
      ...(inlineHeadersObj !== undefined && { inlineHeaders: inlineHeadersObj }),
      ...(headersAccessorName !== undefined && { headers: headersAccessorName }),
      ...(normalizeLeadingSlash !== undefined && { normalizeLeadingSlash }),
    };
  }
  return undefined;
}
