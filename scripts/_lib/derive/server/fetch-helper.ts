import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";

export type FetchHelperFields = {
  local: string;
  base: string;
  serviceLabel: string;
  inlineHeaders?: Record<string, string>;
  headers?: string;
  normalizeLeadingSlash?: true;
  jsonFallbackRaw?: true;
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
        const args = (expr["arguments"] as AstNode[]) ?? [];
        if (args.length !== 0) return undefined;
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
    if (callee.type === "Identifier") {
      const args = (value["arguments"] as AstNode[]) ?? [];
      if (args.length === 0) return `\${env.${String(callee["name"])}}`;
    }
  }
  return undefined;
}

/**
 * Find a plain `key: value` property by its key name. A `SpreadElement` (`{ ...opts, headers:
 * {...} }`) has no `key` — indexing into it unguarded is what crashed this recognizer on
 * discord, google-meet and four zz* fixtures. Skipping non-`ObjectProperty` entries here means
 * a spread anywhere in the options object simply does not match, rather than crashing.
 */
function findObjectProperty(properties: readonly AstNode[], name: string): AstNode | undefined {
  return properties.find((p) => {
    if (p.type !== "ObjectProperty") return false;
    const key = p["key"] as AstNode;
    return key.type === "Identifier" && key["name"] === name;
  });
}

/**
 * Extract inline headers from an ObjectExpression headers object.
 * Returns the headers object or undefined if not inline form.
 */
function inlineHeadersObject(fetchCall: AstNode): Record<string, string> | undefined {
  const options = (fetchCall["arguments"] as AstNode[])[1];
  const properties = (options?.["properties"] as AstNode[] | undefined) ?? [];
  const headers = findObjectProperty(properties, "headers");
  const headersValue = headers?.["value"] as AstNode | undefined;

  // Must be an ObjectExpression for inline headers
  if (headersValue?.type !== "ObjectExpression") return undefined;

  const entries = (headersValue["properties"] as AstNode[]) ?? [];
  if (entries.length === 0) return undefined;

  const out: Record<string, string> = {};
  for (const entry of entries) {
    // Same SpreadElement hazard as findObjectProperty, one level down: `{ ...common,
    // "X-Api-Key": k }` as the headers object itself. Not a plain key/value headers object, so
    // reject the whole helper rather than reading past what this shape models.
    if (entry.type !== "ObjectProperty") return undefined;
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
  const headers = findObjectProperty(properties, "headers");
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
 * The normalizeLeadingSlash statement, exactly:
 * `const pathPart = path.startsWith("/") ? path : \`/${path}\`;`
 *
 * Matched positionally against ONE statement (the candidate first statement of the body) rather
 * than scanned for anywhere in the function — see recognizeFetchHelper's own comment on why the
 * whole body is now walked positionally instead of independently probed for each shape.
 */
function isPathPartConst(stmt: AstNode): boolean {
  if (stmt.type !== "VariableDeclaration") return false;
  const decls = (stmt["declarations"] as AstNode[]) ?? [];
  if (decls.length !== 1) return false;
  const decl = decls[0]!;
  const id = decl["id"] as AstNode;
  if ((id["name"] as string) !== "pathPart") return false;

  // Validate the init expression is a ConditionalExpression with the required shape
  const init = decl["init"] as AstNode | undefined;
  if (init?.type !== "ConditionalExpression") return false;

  // Test: path.startsWith("/")
  const test = init["test"] as AstNode | undefined;
  if (test?.type !== "CallExpression") return false;
  const testCallee = test["callee"] as AstNode | undefined;
  if (testCallee?.type !== "MemberExpression") return false;
  const testObject = testCallee["object"] as AstNode | undefined;
  if (testObject?.type !== "Identifier" || testObject["name"] !== "path") return false;
  const testProperty = testCallee["property"] as AstNode | undefined;
  if (testProperty?.type !== "Identifier" || testProperty["name"] !== "startsWith") return false;
  const testArgs = (test["arguments"] as AstNode[]) ?? [];
  if (testArgs.length !== 1) return false;
  const testArg = testArgs[0];
  if (!testArg || typeof testArg["value"] !== "string" || testArg["value"] !== "/") return false;

  // Consequent: path (Identifier)
  const consequent = init["consequent"] as AstNode | undefined;
  if (consequent?.type !== "Identifier" || consequent["name"] !== "path") return false;

  // Alternate: `/${path}` (TemplateLiteral)
  const alternate = init["alternate"] as AstNode | undefined;
  if (alternate?.type !== "TemplateLiteral") return false;
  const altQuasis = (alternate["quasis"] as AstNode[]) ?? [];
  const altExpressions = (alternate["expressions"] as AstNode[]) ?? [];
  if (altQuasis.length !== 2 || altExpressions.length !== 1) return false;
  const firstQuasi = altQuasis[0];
  const firstCooked = (firstQuasi?.["value"] as { cooked?: string } | undefined)?.cooked;
  if (firstCooked !== "/") return false;
  const pathExpr = altExpressions[0];
  return pathExpr?.type === "Identifier" && pathExpr["name"] === "path";
}

function bodyStatements(fn: AstNode): AstNode[] {
  return ((fn["body"] as AstNode | undefined)?.["body"] as AstNode[] | undefined) ?? [];
}

/**
 * `const res = await fetch(<url>, <options>);` — the fetch call statement itself, matched
 * positionally. Returns the CallExpression so the caller can read its url/options arguments.
 */
function matchFetchStatement(stmt: AstNode): AstNode | undefined {
  if (stmt.type !== "VariableDeclaration") return undefined;
  const decls = (stmt["declarations"] as AstNode[]) ?? [];
  if (decls.length !== 1) return undefined;
  const decl = decls[0]!;
  const id = decl["id"] as AstNode;
  if (id.type !== "Identifier" || id["name"] !== "res") return undefined;
  const init = decl["init"] as AstNode | undefined;
  if (init?.type !== "AwaitExpression") return undefined;
  const call = init["argument"] as AstNode | undefined;
  if (call?.type !== "CallExpression") return undefined;
  const callee = call["callee"] as AstNode;
  if (callee.type !== "Identifier" || callee["name"] !== "fetch") return undefined;
  const args = (call["arguments"] as AstNode[]) ?? [];
  return args.length === 2 ? call : undefined;
}

/**
 * `const text = await res.text();` — matched positionally, exactly.
 */
function isTextStatement(stmt: AstNode): boolean {
  if (stmt.type !== "VariableDeclaration") return false;
  const decls = (stmt["declarations"] as AstNode[]) ?? [];
  if (decls.length !== 1) return false;
  const decl = decls[0]!;
  const id = decl["id"] as AstNode;
  if (id.type !== "Identifier" || id["name"] !== "text") return false;
  const init = decl["init"] as AstNode | undefined;
  if (init?.type !== "AwaitExpression") return false;
  const call = init["argument"] as AstNode | undefined;
  if (call?.type !== "CallExpression") return false;
  const callee = call["callee"] as AstNode;
  if (callee.type !== "MemberExpression") return false;
  const object = callee["object"] as AstNode;
  const property = callee["property"] as AstNode;
  if (object.type !== "Identifier" || object["name"] !== "res") return false;
  if (property.type !== "Identifier" || property["name"] !== "text") return false;
  return ((call["arguments"] as AstNode[]) ?? []).length === 0;
}

/**
 * `if (!res.ok) { throw new Error(...); }` — matched positionally. The throw's message
 * (serviceLabel) is read separately, by serviceLabelFrom against the whole function: with the
 * body now fully accounted for statement by statement, this is the only throw left in it.
 */
function isThrowGuard(stmt: AstNode): boolean {
  if (stmt.type !== "IfStatement") return false;
  if (stmt["alternate"] != null) return false;
  const test = stmt["test"] as AstNode;
  if (test.type !== "UnaryExpression" || test["operator"] !== "!") return false;
  const arg = test["argument"] as AstNode;
  if (arg.type !== "MemberExpression") return false;
  const object = arg["object"] as AstNode;
  const property = arg["property"] as AstNode;
  if (object.type !== "Identifier" || object["name"] !== "res") return false;
  if (property.type !== "Identifier" || property["name"] !== "ok") return false;
  const consequent = stmt["consequent"] as AstNode | undefined;
  const body =
    consequent?.type === "BlockStatement"
      ? (consequent["body"] as AstNode[] | undefined)
      : undefined;
  return body !== undefined && body.length === 1 && body[0]!.type === "ThrowStatement";
}

/**
 * Every ObjectProperty in the fetch options object other than `headers` — `signal: …`, `cache:
 * …`, or any other literal property a mutation might add. A SpreadElement is deliberately
 * tolerated here, unchanged from before this rewrite: it carries no readable properties, so it
 * cannot smuggle in a header a real corpus fetch call this recognizer already accepts (a spread
 * options object is a shape this recognizer already lived with, not a new gap this rewrite
 * opens).
 */
function hasUnexpectedFetchOption(properties: readonly AstNode[]): boolean {
  return properties.some((p) => {
    if (p.type !== "ObjectProperty") return false;
    const key = p["key"] as AstNode;
    const name =
      key.type === "Identifier"
        ? key["name"]
        : key.type === "StringLiteral"
          ? key["value"]
          : undefined;
    return name !== "headers";
  });
}

/** `JSON.parse(text) as unknown` — the argument both of renderFetchHelper's return forms share. */
function isJsonParseTextAsUnknown(node: AstNode | undefined): boolean {
  if (node?.type !== "TSAsExpression") return false;
  const typeAnnotation = node["typeAnnotation"] as AstNode | undefined;
  if (typeAnnotation?.type !== "TSUnknownKeyword") return false;
  const expr = node["expression"] as AstNode | undefined;
  if (expr?.type !== "CallExpression") return false;
  const callee = expr["callee"] as AstNode | undefined;
  if (callee?.type !== "MemberExpression") return false;
  const object = callee["object"] as AstNode | undefined;
  const property = callee["property"] as AstNode | undefined;
  if (object?.type !== "Identifier" || object["name"] !== "JSON") return false;
  if (property?.type !== "Identifier" || property["name"] !== "parse") return false;
  const args = (expr["arguments"] as AstNode[] | undefined) ?? [];
  return args.length === 1 && args[0]?.type === "Identifier" && args[0]["name"] === "text";
}

/** `return JSON.parse(text) as unknown;` — the plain (jsonFallbackRaw: false) return form. */
function isPlainJsonReturn(node: AstNode): boolean {
  return (
    node.type === "ReturnStatement" &&
    isJsonParseTextAsUnknown(node["argument"] as AstNode | undefined)
  );
}

/** `return { raw: text };` — the catch arm's fallback, exactly. */
function isRawFallbackReturn(node: AstNode): boolean {
  if (node.type !== "ReturnStatement") return false;
  const arg = node["argument"] as AstNode | undefined;
  if (arg?.type !== "ObjectExpression") return false;
  const properties = (arg["properties"] as AstNode[] | undefined) ?? [];
  if (properties.length !== 1) return false;
  const prop = properties[0]!;
  if (prop.type !== "ObjectProperty") return false;
  const key = prop["key"] as AstNode;
  const value = prop["value"] as AstNode;
  return (
    key.type === "Identifier" &&
    key["name"] === "raw" &&
    value.type === "Identifier" &&
    value["name"] === "text"
  );
}

/**
 * `try { return JSON.parse(text) as unknown; } catch { return { raw: text }; }` — the
 * jsonFallbackRaw: true form, pinned exactly: a bare `catch` (no binding), a one-statement
 * try block, a one-statement catch block, no finally. Anything else with a TryStatement in
 * this position (a caught binding, extra statements, a different fallback value) is not this
 * shape and is refused rather than approximated.
 */
function isJsonFallbackTry(node: AstNode): boolean {
  if (node.type !== "TryStatement") return false;
  if (node["finalizer"] != null) return false;
  const block = node["block"] as AstNode | undefined;
  const blockBody =
    block?.type === "BlockStatement" ? (block["body"] as AstNode[] | undefined) : undefined;
  if (blockBody === undefined || blockBody.length !== 1 || !isPlainJsonReturn(blockBody[0]!)) {
    return false;
  }
  const handler = node["handler"] as AstNode | undefined;
  if (handler?.type !== "CatchClause" || handler["param"] != null) return false;
  const handlerBlock = handler["body"] as AstNode | undefined;
  const handlerBody =
    handlerBlock?.type === "BlockStatement"
      ? (handlerBlock["body"] as AstNode[] | undefined)
      : undefined;
  return (
    handlerBody !== undefined && handlerBody.length === 1 && isRawFallbackReturn(handlerBody[0]!)
  );
}

/**
 * The read helper's final statement, classified against the only two shapes
 * `renderFetchHelper` can end with: `true` for the jsonFallbackRaw try/catch, `false` for the
 * plain return, `undefined` for anything else (reject the whole helper — Gap C).
 */
function classifyLastStatement(node: AstNode): boolean | undefined {
  if (isPlainJsonReturn(node)) return false;
  if (isJsonFallbackTry(node)) return true;
  return undefined;
}

/**
 * The read helper, as src/emit/server/fetch-helper.ts writes it. Recognized by shape rather
 * than by name: the local is derived from the spec by formula, so matching on a name would
 * only recognize the connectors whose author happened to agree with the formula.
 *
 * Final fix wave: this used to `find()`/`walk()` the whole function tree for the fetch call and
 * classify only the LAST statement, leaving everything between the top of the body and that
 * last statement unverified — claims.claim(s, "fetch-helper") below claims the function's whole
 * byte range at the top level, so an extra statement inserted anywhere in the middle (a stray
 * `const retries = 3;`, an `if (res.status === 429) { … }` retry branch) was silently accepted
 * along with it. The body is now walked positionally instead: an optional pathPart const, the
 * fetch call, the text() read, the !res.ok guard, then exactly one closing statement (the plain
 * return or the jsonFallbackRaw try/catch) — nothing more, nothing reordered.
 */
export function recognizeFetchHelper(
  statements: readonly AstNode[],
  claims: ClaimSet,
): FetchHelperFields | undefined {
  for (const s of statements) {
    if (s.type !== "FunctionDeclaration" || s["async"] !== true) continue;

    // The read helper always takes a single `path` parameter — the write helper (`<local>Send`)
    // takes three, so this alone keeps the two from being confused before the body shapes
    // (which already disambiguate them, via the catch's fallback value) are even considered.
    const params = (s["params"] as AstNode[]) ?? [];
    if (params.length !== 1) continue;
    const param = params[0]!;
    if (param.type !== "Identifier" || param["name"] !== "path") continue;

    // Fix for correlation defect: count fetch() calls. If != 1, reject.
    if (countFetchCalls(s) !== 1) continue;

    const body = bodyStatements(s);
    let idx = 0;

    const normalizeLeadingSlash =
      idx < body.length && isPathPartConst(body[idx]!) ? true : undefined;
    if (normalizeLeadingSlash !== undefined) idx++;

    const fetchCall = idx < body.length ? matchFetchStatement(body[idx]!) : undefined;
    if (fetchCall === undefined) continue;
    idx++;

    if (idx >= body.length || !isTextStatement(body[idx]!)) continue;
    idx++;

    if (idx >= body.length || !isThrowGuard(body[idx]!)) continue;
    idx++;

    // Exactly one statement left — the plain return or the jsonFallbackRaw try/catch. Not zero
    // (a helper cannot end at the guard), not two-or-more (an extra statement here is exactly
    // the class of mutation this rewrite closes).
    if (body.length - idx !== 1) continue;
    const jsonFallback = classifyLastStatement(body[idx]!);
    if (jsonFallback === undefined) continue;

    const options = (fetchCall["arguments"] as AstNode[])[1];
    if (options?.type !== "ObjectExpression") continue;
    if (hasUnexpectedFetchOption((options["properties"] as AstNode[]) ?? [])) continue;

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

    claims.claim(s, "fetch-helper");
    return {
      local,
      base,
      serviceLabel,
      ...(inlineHeadersObj !== undefined && { inlineHeaders: inlineHeadersObj }),
      ...(headersAccessorName !== undefined && { headers: headersAccessorName }),
      ...(normalizeLeadingSlash !== undefined && { normalizeLeadingSlash }),
      ...(jsonFallback && { jsonFallbackRaw: true as const }),
    };
  }
  return undefined;
}
