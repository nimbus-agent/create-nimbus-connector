import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import {
  asExpression,
  assignment,
  awaited,
  blockBody,
  callArgs,
  calleeOf,
  callTo,
  catchClause,
  conditional,
  constDecl,
  expressionOf,
  functionBody,
  functionName,
  functionParams,
  identName,
  ifStatement,
  isAsyncFunction,
  isComputedProperty,
  isIdent,
  isNullLiteral,
  memberOn,
  methodCallTo,
  objectExpressionProperties,
  objectProperty,
  objectProps,
  optionalMemberName,
  optionalMemberObject,
  returnArgument,
  spreadArgument,
  stringLit,
  templateLiteral,
  tryStatement,
  unary,
  uninitializedLet,
} from "../read.ts";

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

/**
 * Reconstruct the full base URL from the template literal, handling env variable references.
 * For `` `https://${siteHost()}${path}` ``, extracts "https://${env.siteHost}".
 * The last expression is the path variable and is excluded from the base.
 */
function reconstructBase(template: AstNode): string | undefined {
  const t = templateLiteral(template);
  if (t === undefined) return undefined;
  const { quasis, expressions } = t;

  // The last expression should be the path variable (Identifier: path or pathPart).
  // Drop it and the trailing quasi.
  if (expressions.length === 0 || quasis.length === 0) return undefined;
  if (identName(expressions.at(-1)) === undefined) return undefined;

  // Reconstruct: concatenate quasis[0..n-2] and expressions[0..n-2],
  // then the first n-1 quasis' cooked values.
  const parts: string[] = [];
  const numToUse = expressions.length - 1;

  for (let i = 0; i <= numToUse; i++) {
    const cooked = quasis[i];
    if (cooked === undefined) return undefined;
    parts.push(cooked);

    if (i < numToUse) {
      const args = callArgs(expressions[i]);
      if (args === undefined || args.length !== 0) return undefined;
      const name = identName(calleeOf(expressions[i]));
      if (name === undefined) return undefined;
      parts.push(`\${env.${name}}`);
    }
  }

  // The quasi trailing the path expression (quasis[numToUse + 1], i.e. the template's LAST
  // quasi) is never pushed onto `parts` above — it comes after the identifier this function
  // treats as the path, so it is not part of the base. It is only safe to drop when it is
  // empty: `` `https://api.example.com${path}` `` has "" there, but
  // `` `https://api.example.com${path}.json` `` has ".json", and dropping that unchecked
  // derives base "https://api.example.com" while silently losing the ".json" suffix — a wrong
  // claim, not a rejection. Reject instead.
  if (quasis[numToUse + 1] !== "") return undefined;

  return parts.join("");
}

function headerValue(value: AstNode): string | undefined {
  const lit = stringLit(value);
  if (lit !== undefined) return lit;
  const args = callArgs(value);
  if (args !== undefined && args.length === 0) {
    const name = identName(calleeOf(value));
    if (name !== undefined) return `\${env.${name}}`;
  }
  return undefined;
}

/**
 * Find a plain `key: value` property by its key name. A `SpreadElement` (`{ ...opts, headers:
 * {...} }`) has no `key` — indexing into it unguarded is what crashed this recognizer on
 * discord, google-meet and four zz* fixtures. `objectProperty` returns undefined for a
 * SpreadElement rather than a key, so a spread anywhere in the options object simply does not
 * match, rather than crashing.
 *
 * A computed key (`{ [headers]: {...} }`) is rejected too: `objectProperty`'s `key` for it is an
 * Identifier naming the KEY VARIABLE, not the literal "headers" — `isIdent(parts.key, name)`
 * would otherwise read `{ [headers]: v }` as though it declared a property literally named
 * "headers" whenever that variable happened to share the name being searched for.
 */
function findObjectProperty(properties: readonly AstNode[], name: string): AstNode | undefined {
  return properties.find((p) => {
    if (isComputedProperty(p)) return false;
    const parts = objectProperty(p);
    return parts !== undefined && isIdent(parts.key, name);
  });
}

/**
 * Extract inline headers from an ObjectExpression headers object.
 * Returns the headers object or undefined if not inline form.
 *
 * The inner entries are parsed wholesale via `objectProps` (any entry it cannot resolve —
 * a spread, a computed key, e.g. `{ ...common, "X-Api-Key": k }` as the headers object itself —
 * rejects the whole object rather than being skipped): unlike `findObjectProperty`'s search
 * over the outer fetch-options list, every entry here is meant to become a header.
 */
function inlineHeadersObject(fetchCall: AstNode): Record<string, string> | undefined {
  const options = callArgs(fetchCall)?.[1];
  const properties = objectExpressionProperties(options) ?? [];
  const headers = findObjectProperty(properties, "headers");
  const headersValue = objectProperty(headers)?.value;

  const entries = objectProps(headersValue);
  if (entries === undefined || entries.length === 0) return undefined;

  const out: Record<string, string> = {};
  for (const entry of entries) {
    const value = headerValue(entry.value);
    if (value === undefined) return undefined;
    out[entry.key] = value;
  }
  return out;
}

/**
 * Extract the headers accessor name from the CallExpression form.
 * For `{ headers: headers() }` or `{ headers: authHeaders() }`, returns "headers" or "authHeaders".
 */
function headersAccessor(fetchCall: AstNode): string | undefined {
  const options = callArgs(fetchCall)?.[1];
  const properties = objectExpressionProperties(options) ?? [];
  const headers = findObjectProperty(properties, "headers");
  const headersValue = objectProperty(headers)?.value;

  const args = callArgs(headersValue);
  if (args === undefined || args.length !== 0) return undefined;
  return identName(calleeOf(headersValue));
}

/** The `<serviceLabel>` in `` throw new Error(`<serviceLabel> ${String(res.status)}: …`) ``. */
function serviceLabelFrom(fn: AstNode): string | undefined {
  const thrown = find(fn, (n) => n.type === "ThrowStatement");
  if (thrown === undefined) return undefined;
  const template = find(thrown, (n) => n.type === "TemplateLiteral");
  const head = template === undefined ? undefined : templateLiteral(template)?.quasis[0];
  return head === undefined ? undefined : head.replace(/ $/, "");
}

/**
 * Count fetch() calls in the function body. Must be exactly 1 to unambiguously identify
 * the real fetch helper (not a decoy with its own headers object).
 */
function countFetchCalls(fn: AstNode): number {
  let count = 0;
  walk(fn, (n) => {
    if (isIdent(calleeOf(n), "fetch")) count++;
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
 *
 * `constDecl` carries the `kind === "const"` guard this used to check by hand — without it,
 * `let pathPart = ...` passed every check below and was claimed as the documented `const` line,
 * same gap as server/index.ts's isRegistrarConst.
 */
function isPathPartConst(stmt: AstNode): boolean {
  const decl = constDecl(stmt);
  if (decl === undefined || decl.name !== "pathPart") return false;

  const c = conditional(decl.init);
  if (c === undefined) return false;

  // Test: path.startsWith("/")
  const testArgs = methodCallTo(c.test, "path", "startsWith", 1);
  if (testArgs === undefined || stringLit(testArgs[0]) !== "/") return false;

  // Consequent: path (Identifier)
  if (!isIdent(c.consequent, "path")) return false;

  // Alternate: `/${path}` (TemplateLiteral)
  const alt = templateLiteral(c.alternate);
  if (alt === undefined || alt.expressions.length !== 1 || alt.quasis[0] !== "/") return false;
  return isIdent(alt.expressions[0], "path");
}

/**
 * `const res = await fetch(<url>, <options>);` — the fetch call statement itself, matched
 * positionally. Returns the CallExpression so the caller can read its url/options arguments.
 *
 * `constDecl` carries the `kind === "const"` guard this used to check by hand — without it,
 * `let res = await fetch(...)` passed every check below and was claimed as the documented
 * `const` line, same gap as server/index.ts's isRegistrarConst.
 */
function matchFetchStatement(stmt: AstNode): AstNode | undefined {
  const decl = constDecl(stmt);
  if (decl === undefined || decl.name !== "res") return undefined;
  const call = awaited(decl.init);
  return callTo(call, "fetch", 2) === undefined ? undefined : call;
}

/**
 * `const text = await res.text();` — matched positionally, exactly.
 *
 * `constDecl` carries the `kind === "const"` guard this used to check by hand — without it,
 * `let text = await res.text();` passed every check below and was claimed as the documented
 * `const` line, same gap as server/index.ts's isRegistrarConst.
 */
function isTextStatement(stmt: AstNode): boolean {
  const decl = constDecl(stmt);
  if (decl === undefined || decl.name !== "text") return false;
  const call = awaited(decl.init);
  return methodCallTo(call, "res", "text", 0) !== undefined;
}

/**
 * `if (!res.ok) { throw new Error(...); }` — matched positionally. The throw's message
 * (serviceLabel) is read separately, by serviceLabelFrom against the whole function: with the
 * body now fully accounted for statement by statement, this is the only throw left in it.
 */
function isThrowGuard(stmt: AstNode): boolean {
  const s = ifStatement(stmt);
  if (s === undefined || s.alternate !== undefined) return false;

  const u = unary(s.test);
  if (u === undefined || u.operator !== "!") return false;
  if (memberOn(u.argument, "res") !== "ok") return false;

  const body = blockBody(s.consequent);
  return body !== undefined && body.length === 1 && body[0]?.type === "ThrowStatement";
}

/**
 * Every ObjectProperty in the fetch options object other than `headers` — `signal: …`, `cache:
 * …`, or any other literal property a mutation might add. A SpreadElement is deliberately
 * tolerated here, unchanged from before this rewrite: it carries no readable properties, so it
 * cannot smuggle in a header a real corpus fetch call this recognizer already accepts (a spread
 * options object is a shape this recognizer already lived with, not a new gap this rewrite
 * opens). `objectProperty` returns undefined for a SpreadElement, which this treats the same as
 * `p.type !== "ObjectProperty"` did before: tolerated, not "headers", skipped.
 *
 * A computed key (`{ [headers]: … }`) is treated as unexpected — the safe direction — rather
 * than resolved: `identName(parts.key)` on a computed property's key names the KEY VARIABLE, not
 * a property, and `{ [headers]: … }` reading as though it declared a property literally named
 * "headers" is the exact hazard `findObjectProperty` above guards against; a mutation this
 * recognizer cannot name honestly should block the fetch helper, not be waved through as "not
 * headers, therefore fine".
 */
function hasUnexpectedFetchOption(properties: readonly AstNode[]): boolean {
  return properties.some((p) => {
    const parts = objectProperty(p);
    if (parts === undefined) return false;
    if (isComputedProperty(p)) return true;
    const name = identName(parts.key) ?? stringLit(parts.key);
    return name !== "headers";
  });
}

/** `JSON.parse(text) as unknown` — the argument both of renderFetchHelper's return forms share. */
function isJsonParseTextAsUnknown(node: AstNode | undefined): boolean {
  const a = asExpression(node);
  if (a === undefined || a.typeAnnotationType !== "TSUnknownKeyword") return false;
  const args = methodCallTo(a.expression, "JSON", "parse", 1);
  return args !== undefined && isIdent(args[0], "text");
}

/** `return JSON.parse(text) as unknown;` — the plain (jsonFallbackRaw: false) return form. */
function isPlainJsonReturn(node: AstNode): boolean {
  return isJsonParseTextAsUnknown(returnArgument(node));
}

/** `return { raw: text };` — the catch arm's fallback, exactly. */
function isRawFallbackReturn(node: AstNode): boolean {
  const properties = objectExpressionProperties(returnArgument(node));
  if (properties === undefined || properties.length !== 1) return false;
  const parts = objectProperty(properties[0]);
  return parts !== undefined && isIdent(parts.key, "raw") && isIdent(parts.value, "text");
}

/**
 * `try { return JSON.parse(text) as unknown; } catch { return { raw: text }; }` — the
 * jsonFallbackRaw: true form, pinned exactly: a bare `catch` (no binding), a one-statement
 * try block, a one-statement catch block, no finally. Anything else with a TryStatement in
 * this position (a caught binding, extra statements, a different fallback value) is not this
 * shape and is refused rather than approximated.
 */
function isJsonFallbackTry(node: AstNode): boolean {
  const t = tryStatement(node);
  if (t === undefined || t.finalizer !== undefined) return false;

  const tryBody = blockBody(t.block);
  if (tryBody === undefined || tryBody.length !== 1 || !isPlainJsonReturn(tryBody[0]!)) {
    return false;
  }

  const c = catchClause(t.handler);
  if (c === undefined || c.param !== undefined) return false;
  const handlerBody = blockBody(c.body);
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
    if (s.type !== "FunctionDeclaration" || !isAsyncFunction(s)) continue;

    // The read helper always takes a single `path` parameter — the write helper (`<local>Send`)
    // takes three, so this alone keeps the two from being confused before the body shapes
    // (which already disambiguate them, via the catch's fallback value) are even considered.
    const params = functionParams(s);
    if (params === undefined || params.length !== 1 || !isIdent(params[0], "path")) continue;

    // Fix for correlation defect: count fetch() calls. If != 1, reject.
    if (countFetchCalls(s) !== 1) continue;

    const body = functionBody(s) ?? [];
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

    const options = callArgs(fetchCall)?.[1];
    const optionProps = objectExpressionProperties(options);
    if (optionProps === undefined) continue;
    if (hasUnexpectedFetchOption(optionProps)) continue;

    const url = callArgs(fetchCall)?.[0];
    const base = url === undefined ? undefined : reconstructBase(url);
    const inlineHeadersObj = inlineHeadersObject(fetchCall);
    const headersAccessorName = headersAccessor(fetchCall);
    const serviceLabel = serviceLabelFrom(s);
    const local = functionName(s) ?? "";

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

// ---------------------------------------------------------------------------
// The rest-kit fetch helper — renderRestKitFetchHelper, a different shape from the read
// helper above. `renderReadHelper` (src/emit/server/fetch-helper.ts) does NOT gate this on
// `isHandStyle`: rest-kit is unconditional, since makeRestToolRegistrar is handed the helper
// directly and has no seam to skip it, even for a spec with no tools at all. The above
// `recognizeFetchHelper` cannot see it — it requires exactly one parameter named `path`, and
// this helper takes three (`token`, `path`, `init?`) — so it needs its own recognizer, kept in
// this module rather than tools-rest.ts to preserve the one-recognizer-per-emitter-function
// mapping: a future change to renderRestKitFetchHelper with no matching change here is then a
// diff in the same file, not a silent gap in a different one.
// ---------------------------------------------------------------------------

export type RestFetchHelperFields = {
  local: string;
  base: string;
  inlineHeaders?: Record<string, string>;
};

/**
 * `const url = path.startsWith("http") ? path : \`<base>${path}\`;` — statement 1 of
 * renderRestKitFetchHelper's body, matched exactly (same `path.startsWith("http")` guard
 * `isPathPartConst` above checks, but naming a different const). Returns the literal base
 * text.
 *
 * Only the LITERAL base form. `baseExpr` can also produce `` `${baseConst}${path}` `` — a
 * second, distinct template shape (two expressions instead of one) — which this recognizer
 * refuses rather than partially reads: none of the three connectors this plan's frame and
 * tools recognizers newly reach (circleci, github-actions, pagerduty) need it to derive
 * successfully, since each blocks earlier on its own out-of-scope tool shape (a query branch
 * or a bespoke `reg()` call).
 */
function matchRestUrlConst(stmt: AstNode): string | undefined {
  const decl = constDecl(stmt);
  if (decl === undefined || decl.name !== "url") return undefined;

  const c = conditional(decl.init);
  if (c === undefined) return undefined;

  const testArgs = methodCallTo(c.test, "path", "startsWith", 1);
  if (testArgs === undefined || stringLit(testArgs[0]) !== "http") return undefined;
  if (!isIdent(c.consequent, "path")) return undefined;

  const alt = templateLiteral(c.alternate);
  if (alt === undefined || alt.expressions.length !== 1 || !isIdent(alt.expressions[0], "path")) {
    return undefined;
  }

  const base = alt.quasis[0];
  if (base === undefined || alt.quasis[1] !== "") return undefined;
  return base;
}

/** `Authorization: \`Bearer ${token}\`` — the headers object's fixed first entry. */
function isAuthorizationHeader(parts: { key: AstNode; value: AstNode }): boolean {
  if (identName(parts.key) !== "Authorization") return false;
  const t = templateLiteral(parts.value);
  if (t === undefined || t.expressions.length !== 1) return false;
  return t.quasis[0] === "Bearer " && t.quasis[1] === "" && isIdent(t.expressions[0], "token");
}

/** `...(init?.headers as Record<string, string> | undefined)` — the headers object's fixed trailing spread. */
function isInitHeadersSpread(node: AstNode): boolean {
  const a = asExpression(spreadArgument(node));
  if (a === undefined || a.typeAnnotationType !== "TSUnionType") return false;
  return (
    optionalMemberName(a.expression) === "headers" &&
    identName(optionalMemberObject(a.expression)) === "init"
  );
}

/**
 * The `headers:` object's inline entries — renderRestKitFetchHelper's `extra` block, each a
 * literal `<key>: "<value>",`. Rest-kit's `inlineHeaders` values never carry `${env.X}`: the
 * schema's own rest-kit refine already rejects that at parse time, since rest-kit emits no
 * accessor to call — so a plain string literal is the only value shape possible here, unlike
 * `headerValue` above (the hand-style helper's equivalent), which also accepts an env-accessor
 * call.
 */
function restInlineHeaderEntries(
  properties: readonly AstNode[],
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const property of properties) {
    if (isComputedProperty(property)) return undefined;
    const parts = objectProperty(property);
    if (parts === undefined) return undefined;
    const key = identName(parts.key) ?? stringLit(parts.key);
    const value = stringLit(parts.value);
    if (key === undefined || value === undefined) return undefined;
    out[key] = value;
  }
  return out;
}

/**
 * The `headers: {...}` object itself: the fixed `Authorization` entry, zero or more inline
 * extra headers, then the fixed trailing `...init?.headers` spread — in that order, exactly.
 * The outer (undefined | { inlineHeaders? }) distinguishes "this object does not match at
 * all" (outer undefined) from "it matches and declares no extra headers" (inner `{}`) — the
 * two would otherwise be indistinguishable now that middle.length === 0 is a valid match.
 */
function matchHeadersObject(node: AstNode): { inlineHeaders?: Record<string, string> } | undefined {
  const properties = objectExpressionProperties(node);
  if (properties === undefined || properties.length < 2) return undefined;

  const first = properties[0];
  const last = properties.at(-1);
  if (first === undefined || last === undefined) return undefined;

  const firstParts = objectProperty(first);
  if (firstParts === undefined || !isAuthorizationHeader(firstParts)) return undefined;
  if (!isInitHeadersSpread(last)) return undefined;

  const middle = properties.slice(1, -1);
  if (middle.length === 0) return {};

  const inlineHeaders = restInlineHeaderEntries(middle);
  return inlineHeaders === undefined ? undefined : { inlineHeaders };
}

/** The fetch() options object: `{ ...init, headers: {...} }` — exactly these two entries, in this order. */
function matchRestFetchOptions(
  node: AstNode,
): { inlineHeaders?: Record<string, string> } | undefined {
  const properties = objectExpressionProperties(node);
  if (properties === undefined || properties.length !== 2) return undefined;

  const initSpread = properties[0];
  const headersEntry = properties[1];
  if (initSpread === undefined || headersEntry === undefined) return undefined;
  if (!isIdent(spreadArgument(initSpread), "init")) return undefined;

  if (isComputedProperty(headersEntry)) return undefined;
  const headersParts = objectProperty(headersEntry);
  if (headersParts === undefined || identName(headersParts.key) !== "headers") return undefined;

  return matchHeadersObject(headersParts.value);
}

/** `const res = await fetch(url, { ...init, headers: {...} });` — statement 2, matched exactly. */
function matchRestFetchStatement(
  stmt: AstNode,
): { inlineHeaders?: Record<string, string> } | undefined {
  const decl = constDecl(stmt);
  if (decl === undefined || decl.name !== "res") return undefined;
  const call = awaited(decl.init);
  const args = callTo(call, "fetch", 2);
  if (args === undefined || !isIdent(args[0], "url")) return undefined;
  const options = args[1];
  return options === undefined ? undefined : matchRestFetchOptions(options);
}

/**
 * `json = <matches>;`, wrapped in the try/catch's fixed `json` target — `assignment` reads
 * the AssignmentExpression itself; this is the one check both try and catch arms share, only
 * `matches` differing (`JSON.parse(text) as unknown` vs `null`).
 */
function isJsonAssign(stmt: AstNode, matches: (right: AstNode | undefined) => boolean): boolean {
  const a = assignment(expressionOf(stmt));
  if (a === undefined || a.operator !== "=" || !isIdent(a.left, "json")) return false;
  return matches(a.right);
}

/**
 * `try { json = JSON.parse(text) as unknown; } catch { json = null; }` — statement 5, matched
 * exactly: a bare `catch` (no binding), a one-statement try block, a one-statement catch
 * block, no finally. The ASSIGNING form of `isJsonFallbackTry` above, which instead RETURNS
 * from each arm — the one shape difference between the hand-style read helper and this one.
 */
function isRestJsonTryCatch(node: AstNode): boolean {
  const t = tryStatement(node);
  if (t === undefined || t.finalizer !== undefined) return false;

  const tryBody = blockBody(t.block);
  if (
    tryBody === undefined ||
    tryBody.length !== 1 ||
    !isJsonAssign(tryBody[0]!, isJsonParseTextAsUnknown)
  ) {
    return false;
  }

  const c = catchClause(t.handler);
  if (c === undefined || c.param !== undefined) return false;
  const handlerBody = blockBody(c.body);
  return (
    handlerBody !== undefined &&
    handlerBody.length === 1 &&
    isJsonAssign(handlerBody[0]!, isNullLiteral)
  );
}

/** `return { ok: res.ok, status: res.status, json, text };` — statement 6, matched exactly, in this order. */
function isRestReturnStatement(node: AstNode): boolean {
  const props = objectProps(returnArgument(node));
  if (props === undefined || props.length !== 4) return false;
  const ok = props[0];
  const status = props[1];
  const json = props[2];
  const text = props[3];
  if (ok === undefined || status === undefined || json === undefined || text === undefined) {
    return false;
  }
  return (
    ok.key === "ok" &&
    memberOn(ok.value, "res") === "ok" &&
    status.key === "status" &&
    memberOn(status.value, "res") === "status" &&
    json.key === "json" &&
    isIdent(json.value, "json") &&
    text.key === "text" &&
    isIdent(text.value, "text")
  );
}

/**
 * The inverse of renderRestKitFetchHelper — a fixed six-statement body, matched positionally
 * (the same reason `recognizeFetchHelper` above walks its own body positionally rather than
 * `find()`/`walk()`-ing the tree: a claim covers the function's whole byte range, so an extra
 * or reordered statement anywhere inside it must be visible here, not silently swallowed by a
 * shape check that only samples part of the body). Refuses rather than partially reads any
 * step it does not recognize — a wrong `base` regenerates a connector that requests the wrong
 * host and byte-matches nothing, and the failure would look like a formatting problem rather
 * than what it is.
 */
export function recognizeRestFetchHelper(
  statements: readonly AstNode[],
  claims: ClaimSet,
): RestFetchHelperFields | undefined {
  for (const s of statements) {
    if (s.type !== "FunctionDeclaration" || !isAsyncFunction(s)) continue;

    const params = functionParams(s);
    if (
      params === undefined ||
      params.length !== 3 ||
      !isIdent(params[0], "token") ||
      !isIdent(params[1], "path") ||
      !isIdent(params[2], "init")
    ) {
      continue;
    }

    const body = functionBody(s);
    if (body === undefined || body.length !== 6) continue;

    const base = matchRestUrlConst(body[0]!);
    if (base === undefined) continue;

    const headers = matchRestFetchStatement(body[1]!);
    if (headers === undefined) continue;

    if (!isTextStatement(body[2]!)) continue;
    if (uninitializedLet(body[3]!) !== "json") continue;
    if (!isRestJsonTryCatch(body[4]!)) continue;
    if (!isRestReturnStatement(body[5]!)) continue;

    const local = functionName(s);
    if (local === undefined || local === "") continue;

    claims.claim(s, "rest-fetch-helper");
    return {
      local,
      base,
      ...(headers.inlineHeaders !== undefined ? { inlineHeaders: headers.inlineHeaders } : {}),
    };
  }
  return undefined;
}
