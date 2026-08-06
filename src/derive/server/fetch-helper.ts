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
  logical,
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
  /** Set only when `base` was hoisted to a module-scope const — see `reconstructBase`. */
  baseConst?: string;
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
 * Resolve an Identifier's name against a top-level `const <name> = "<literal>";` in the same
 * module — the read side of `renderBaseConst` (src/emit/server/fetch-helper.ts), which writes
 * exactly that shape when `fetchHelper.baseConst` is set. A name that resolves to anything else
 * (a `let`, an import, a computed initializer such as `someExpression()`) is refused rather than
 * partially read: resolving loosely would invent a base, and a connector requesting the wrong
 * host is a worse outcome than a visible blocker. Shared by `reconstructBase` (hand-rolled) and
 * `matchRestUrlConst` (rest-kit) below — both read the identical const shape.
 */
function resolveConstString(
  name: string,
  statements: readonly AstNode[],
): { text: string; statement: AstNode } | undefined {
  for (const stmt of statements) {
    const decl = constDecl(stmt);
    if (decl?.name !== name) continue;
    const text = stringLit(decl.init);
    return text === undefined ? undefined : { text, statement: stmt };
  }
  return undefined;
}

/** What `reconstructBase` recovers: the base text, and — only for a hoisted base — the const's name and its own statement (for the caller to claim). */
type ReconstructedBase = {
  readonly base: string;
  readonly baseConst?: string;
  readonly constStatement?: AstNode;
};

/**
 * Reconstruct the full base URL from the template literal, handling env variable references and
 * a hoisted base const. For `` `https://${siteHost()}${path}` ``, extracts
 * "https://${env.siteHost}". For `` `${BASE}${path}` ``, resolves `BASE` against `statements`
 * and extracts the literal it holds, recording `baseConst: "BASE"`. The last expression is the
 * path variable and is excluded from the base.
 */
function reconstructBase(
  template: AstNode,
  statements: readonly AstNode[],
): ReconstructedBase | undefined {
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
  let baseConst: string | undefined;
  let constStatement: AstNode | undefined;

  for (let i = 0; i <= numToUse; i++) {
    const cooked = quasis[i];
    if (cooked === undefined) return undefined;
    parts.push(cooked);

    if (i < numToUse) {
      // The hoisted-base identifier branch applies only when it is the SOLE non-final
      // expression — not a judgment call, but what the emitter can produce. renderBaseConst
      // writes exactly ONE const holding the ENTIRE base
      // (`const ${baseConst} = ${JSON.stringify(base)};`), and FetchHelperSchema's own refine
      // (spec.ts) forbids mixing that const with a ${env.X} accessor. So `` `${BASE}${path}` ``
      // (numToUse === 1) is the only shape a hoisted base can produce; `` `${A}${B}${path}` ``
      // (two consts — unproducible, "baseConst" is a single name with nowhere to put the
      // second) and `` `${BASE}${apiVersion()}${path}` `` (a const beside an accessor — the
      // schema refinement forbids the combination) are both refused here, by falling through to
      // the zero-argument-call path below, which rejects a bare Identifier outright.
      if (numToUse === 1 && identName(expressions[i]) !== undefined) {
        const name = identName(expressions[i]);
        const resolved = name === undefined ? undefined : resolveConstString(name, statements);
        if (resolved === undefined) return undefined;
        baseConst = name;
        constStatement = resolved.statement;
        parts.push(resolved.text);
        continue;
      }

      const args = callArgs(expressions[i]);
      if (args?.length !== 0) return undefined;
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

  return { base: parts.join(""), baseConst, constStatement };
}

function headerValue(value: AstNode): string | undefined {
  const lit = stringLit(value);
  if (lit !== undefined) return lit;
  const args = callArgs(value);
  if (args?.length === 0) {
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
  if (args?.length !== 0) return undefined;
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

/** `<receiver>.startsWith("<literal>")` — the one predicate both statements below are built from. */
function startsWithLiteral(node: AstNode | undefined, receiver: string, literal: string): boolean {
  const args = methodCallTo(node, receiver, "startsWith", 1);
  return args !== undefined && stringLit(args[0]) === literal;
}

/**
 * `const url = <pathVar>.startsWith("http") ? <pathVar> : <template>;` -> that template, which is
 * the only part of the statement whose shape differs between the emitters that write it:
 * `renderRestKitFetchHelper` (unconditionally, with a base the schema's rest-kit refine keeps free
 * of `${env.X}`) and `renderFetchHelper` (iff `hasQueryTool` — see that function in
 * src/emit/server/fetch-helper.ts — with a base that may carry env accessors). The ternary shell
 * around it is byte-identical in both, so it is read here once rather than copied into each: a
 * copy is a place for one side to be tightened while the other keeps accepting what its twin just
 * learned to reject (hoists.ts's module docstring states the rule).
 *
 * `renderWriteHelper` writes the same statement under the same gate, and is NOT read here — no
 * recognizer in this plan claims the write helper at all (see round-trip.test.ts's `zzwriteonly`
 * entry), so a spec whose query tool is non-GET blocks on that function rather than on this line.
 *
 * `pathVar` is a parameter because the hand-style helper renames it: `renderFetchHelper` writes
 * the passthrough over `pathPart` when `normalizeLeadingSlash` also asked for that const, and
 * over `path` otherwise. Pinning the test's receiver and the consequent to the SAME variable is
 * what stops a helper that normalizes `path` into `pathPart` and then passes the un-normalized
 * `path` through from being read as the shape the emitter writes.
 */
function passthroughUrlTemplate(stmt: AstNode, pathVar: string): AstNode | undefined {
  const decl = constDecl(stmt);
  if (decl?.name !== "url") return undefined;

  const c = conditional(decl.init);
  if (c === undefined) return undefined;
  if (!startsWithLiteral(c.test, pathVar, "http")) return undefined;
  if (!isIdent(c.consequent, pathVar)) return undefined;
  return c.alternate;
}

/**
 * The normalizeLeadingSlash statement, exactly:
 * `const pathPart = <guard> ? path : \`/${path}\`;`
 *
 * `<guard>` is `path.startsWith("/")`, or `path.startsWith("http") || path.startsWith("/")` when
 * the spec ALSO declares a query tool — `renderFetchHelper` widens it there so an absolute URL is
 * not forced through `` `/${path}` `` into "/https://…". Which guard it carries is returned rather
 * than tolerated (`httpArm`), because the emitter writes the wide guard and the passthrough const
 * below together or neither: `matchFetchHelperBody` holds the two against each other, and a
 * helper carrying one alone is a shape `renderFetchHelper` cannot produce.
 *
 * Matched positionally against ONE statement (the candidate first statement of the body) rather
 * than scanned for anywhere in the function — see `matchFetchHelperBody`'s own comment on why
 * the whole body is now walked positionally instead of independently probed for each shape.
 *
 * `constDecl` carries the `kind === "const"` guard this used to check by hand — without it,
 * `let pathPart = ...` passed every check below and was claimed as the documented `const` line,
 * same gap as server/index.ts's isRegistrarConst.
 */
function matchPathPartConst(stmt: AstNode): { httpArm: boolean } | undefined {
  const decl = constDecl(stmt);
  if (decl?.name !== "pathPart") return undefined;

  const c = conditional(decl.init);
  if (c === undefined) return undefined;

  // Consequent: path (Identifier)
  if (!isIdent(c.consequent, "path")) return undefined;

  // Alternate: `/${path}` (TemplateLiteral)
  const alt = templateLiteral(c.alternate);
  if (alt?.expressions.length !== 1 || alt.quasis[0] !== "/") return undefined;
  if (!isIdent(alt.expressions[0], "path")) return undefined;

  // Test: path.startsWith("/"), or that disjoined behind path.startsWith("http").
  if (startsWithLiteral(c.test, "path", "/")) return { httpArm: false };
  const wide = logical(c.test);
  if (wide?.operator !== "||") return undefined;
  if (!startsWithLiteral(wide.left, "path", "http")) return undefined;
  return startsWithLiteral(wide.right, "path", "/") ? { httpArm: true } : undefined;
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
  if (decl?.name !== "res") return undefined;
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
  if (decl?.name !== "text") return false;
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
  if (u?.operator !== "!") return false;
  if (memberOn(u.argument, "res") !== "ok") return false;

  const body = blockBody(s.consequent);
  return body?.length === 1 && body[0]?.type === "ThrowStatement";
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
  if (a?.typeAnnotationType !== "TSUnknownKeyword") return false;
  const args = methodCallTo(a.expression, "JSON", "parse", 1);
  return args !== undefined && isIdent(args[0], "text");
}

/** `return JSON.parse(text) as unknown;` — the plain (jsonFallbackRaw: false) return form. */
function isPlainJsonReturn(node: AstNode): boolean {
  return isJsonParseTextAsUnknown(returnArgument(node));
}

/**
 * `return { raw: text };` — the catch arm's fallback, exactly.
 *
 * A computed key (`{ [raw]: text }`) is rejected before `objectProperty` is even consulted: its
 * `key` node for a computed property is an Identifier naming the KEY VARIABLE, not the literal
 * "raw", the same hazard `findObjectProperty` above guards against.
 */
function isRawFallbackReturn(node: AstNode): boolean {
  const properties = objectExpressionProperties(returnArgument(node));
  if (properties?.length !== 1) return false;
  const property = properties[0];
  if (property === undefined || isComputedProperty(property)) return false;
  const parts = objectProperty(property);
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
  if (tryBody?.length !== 1 || !isPlainJsonReturn(tryBody[0]!)) {
    return false;
  }

  const c = catchClause(t.handler);
  if (c === undefined || c.param !== undefined) return false;
  const handlerBody = blockBody(c.body);
  return handlerBody?.length === 1 && isRawFallbackReturn(handlerBody[0]!);
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

/** What `matchFetchHelperBody` recovers from the read helper's statement sequence. */
type FetchHelperBody = {
  /** The `fetch(<url>, <options>)` CallExpression itself, for the caller's url/options reads. */
  readonly fetchCall: AstNode;
  /**
   * The template `reconstructBase` reads the base off: the fetch call's own url argument, or —
   * when the passthrough const stands in front of it — that const's alternate, since the fetch
   * call then receives only the `url` binding.
   */
  readonly baseTemplate: AstNode;
  readonly normalizeLeadingSlash: boolean;
  readonly jsonFallbackRaw: boolean;
  /**
   * `` const url = <pathVar>.startsWith("http") ? <pathVar> : `<base>${<pathVar>}`; `` — the
   * statement `renderFetchHelper` emits IFF the spec declares a query tool (`hasQueryTool`,
   * src/emit/server/fetch-helper.ts), so a query tool's absolute-URL return is used as-is rather
   * than having the base prepended a second time.
   *
   * Its presence is EVIDENCE, not a spec field: it appears exactly when some tool carries a
   * `query` array, so the caller cross-checks it against the recognized tools rather than
   * recording it. See `deriveSharedStyleSpec`'s `fetch-helper:query-passthrough-mismatch`.
   */
  readonly passthrough: boolean;
};

/**
 * The read helper's body, walked positionally: an optional pathPart const, an optional
 * passthrough url const, the fetch call, the text() read, the !res.ok guard, then exactly one
 * closing statement (the plain return or the jsonFallbackRaw try/catch) — nothing more, nothing
 * reordered.
 *
 * Final fix wave: this used to `find()`/`walk()` the whole function tree for the fetch call and
 * classify only the LAST statement, leaving everything between the top of the body and that
 * last statement unverified — claims.claim(s, "fetch-helper") claims the function's whole byte
 * range at the top level, so an extra statement inserted anywhere in the middle (a stray
 * `const retries = 3;`, an `if (res.status === 429) { … }` retry branch) was silently accepted
 * along with it. Walking every statement here is what closes that.
 */
function matchFetchHelperBody(body: readonly AstNode[]): FetchHelperBody | undefined {
  let idx = 0;

  const pathPart = idx < body.length ? matchPathPartConst(body[idx]!) : undefined;
  const normalizeLeadingSlash = pathPart !== undefined;
  if (normalizeLeadingSlash) idx++;

  // `renderFetchHelper` writes the passthrough over `pathPart` when it wrote that const, and over
  // `path` otherwise — one `pathVar` local in the emitter, one here.
  const pathVar = normalizeLeadingSlash ? "pathPart" : "path";
  const passthroughTemplate =
    idx < body.length ? passthroughUrlTemplate(body[idx]!, pathVar) : undefined;
  const passthrough = passthroughTemplate !== undefined;
  if (passthrough) idx++;

  // When the pathPart const IS present, its guard and the passthrough const come from the same
  // `hasQueryTool(spec)` call, so a helper carrying one and not the other is a shape
  // `renderFetchHelper` cannot write. Checked only in that case: with no pathPart const there is
  // no guard to widen, and demanding `httpArm` of an absent statement would refuse every
  // passthrough helper that does not also normalize its leading slash — which is every one of
  // them apart from the grafana/newrelic-shaped `normalizeLeadingSlash: true` specs.
  if (pathPart !== undefined && pathPart.httpArm !== passthrough) return undefined;

  const fetchCall = idx < body.length ? matchFetchStatement(body[idx]!) : undefined;
  if (fetchCall === undefined) return undefined;
  idx++;

  const fetchUrl = callArgs(fetchCall)?.[0];
  if (fetchUrl === undefined) return undefined;
  // With the passthrough const in front of it the emitter passes that const's own binding, so
  // the base has already been consumed above; pinned to the identifier `url` rather than accepted
  // as "some expression", or a helper fetching something else entirely would be recorded with a
  // base it never actually requests.
  if (passthrough && !isIdent(fetchUrl, "url")) return undefined;

  if (idx >= body.length || !isTextStatement(body[idx]!)) return undefined;
  idx++;

  if (idx >= body.length || !isThrowGuard(body[idx]!)) return undefined;
  idx++;

  // Exactly one statement left — the plain return or the jsonFallbackRaw try/catch. Not zero
  // (a helper cannot end at the guard), not two-or-more (an extra statement here is exactly
  // the class of mutation this rewrite closes).
  if (body.length - idx !== 1) return undefined;
  const jsonFallbackRaw = classifyLastStatement(body[idx]!);
  if (jsonFallbackRaw === undefined) return undefined;

  return {
    fetchCall,
    baseTemplate: passthroughTemplate ?? fetchUrl,
    normalizeLeadingSlash,
    jsonFallbackRaw,
    passthrough,
  };
}

/**
 * The fetch options object, accepted only when it is an ObjectExpression carrying nothing this
 * recognizer cannot name — see `hasUnexpectedFetchOption` for what "unexpected" covers and why a
 * computed key counts as unexpected. A missing or non-ObjectExpression options argument is
 * refused here rather than read as "no unexpected options".
 */
function hasExpectedFetchOptions(fetchCall: AstNode): boolean {
  const options = callArgs(fetchCall)?.[1];
  const optionProps = objectExpressionProperties(options);
  return optionProps !== undefined && !hasUnexpectedFetchOption(optionProps);
}

/** Either inline headers or an accessor — never both, never neither. */
type FetchHelperHeaders = Pick<FetchHelperFields, "inlineHeaders" | "headers">;

/**
 * The headers half of the fetch options object. `renderFetchHelper` writes exactly one of the
 * two forms, so both present at once (or neither) is refused rather than resolved in favour of
 * one of them.
 */
function matchFetchHelperHeaders(fetchCall: AstNode): FetchHelperHeaders | undefined {
  const inlineHeaders = inlineHeadersObject(fetchCall);
  const headers = headersAccessor(fetchCall);
  if (inlineHeaders !== undefined && headers !== undefined) return undefined;
  if (inlineHeaders !== undefined) return { inlineHeaders };
  return headers === undefined ? undefined : { headers };
}

/** `matchFetchHelperFunction`'s match, plus the hoisted base const's own statement (if any) for the caller to claim alongside the function. */
type MatchedFetchHelper = {
  readonly fields: FetchHelperFields;
  readonly constStatement?: AstNode;
  /** See `FetchHelperBody.passthrough` — evidence about the tools, not a `fetchHelper` field. */
  readonly passthrough: boolean;
};

/**
 * What `recognizeFetchHelper` hands back: the spec fields, and the one piece of recovered
 * evidence that is NOT one. Kept beside `fields` rather than folded into `FetchHelperFields` for
 * the same reason tools-hand.ts's `ToolShape` keeps `staticStyle`/`schemaShape` beside its own
 * `fields` — `FetchHelperSchema` is a `strictObject` that would reject a `passthrough` key, and
 * `deriveSharedStyleSpec` spreads these fields straight into the derived spec.
 */
export type RecognizedFetchHelper = {
  readonly fields: FetchHelperFields;
  readonly passthrough: boolean;
};

/**
 * One candidate statement, tested as the read helper — the whole of `recognizeFetchHelper`'s
 * per-statement work, so the loop below carries only the claim(s). Claims nothing itself: a
 * partial match must leave the ClaimSet untouched.
 *
 * `statements` is the module's top-level statement list, threaded through only so
 * `reconstructBase` can resolve a hoisted base identifier against it — this function does not
 * otherwise search outside `s`.
 */
function matchFetchHelperFunction(
  s: AstNode,
  statements: readonly AstNode[],
): MatchedFetchHelper | undefined {
  if (s.type !== "FunctionDeclaration" || !isAsyncFunction(s)) return undefined;

  // The read helper always takes a single `path` parameter — the write helper (`<local>Send`)
  // takes three, so this alone keeps the two from being confused before the body shapes
  // (which already disambiguate them, via the catch's fallback value) are even considered.
  const params = functionParams(s);
  if (params?.length !== 1 || !isIdent(params[0], "path")) return undefined;

  // Fix for correlation defect: count fetch() calls. If != 1, reject.
  if (countFetchCalls(s) !== 1) return undefined;

  const parsed = matchFetchHelperBody(functionBody(s) ?? []);
  if (parsed === undefined) return undefined;
  if (!hasExpectedFetchOptions(parsed.fetchCall)) return undefined;

  const headers = matchFetchHelperHeaders(parsed.fetchCall);
  if (headers === undefined) return undefined;

  const reconstructed = reconstructBase(parsed.baseTemplate, statements);
  const serviceLabel = serviceLabelFrom(s);
  const local = functionName(s) ?? "";
  if (reconstructed === undefined || serviceLabel === undefined || local === "") return undefined;

  return {
    fields: {
      local,
      base: reconstructed.base,
      ...(reconstructed.baseConst === undefined ? {} : { baseConst: reconstructed.baseConst }),
      serviceLabel,
      ...headers,
      ...(parsed.normalizeLeadingSlash && { normalizeLeadingSlash: true as const }),
      ...(parsed.jsonFallbackRaw && { jsonFallbackRaw: true as const }),
    },
    constStatement: reconstructed.constStatement,
    passthrough: parsed.passthrough,
  };
}

/**
 * The read helper, as src/emit/server/fetch-helper.ts writes it. Recognized by shape rather
 * than by name: the local is derived from the spec by formula, so matching on a name would
 * only recognize the connectors whose author happened to agree with the formula.
 *
 * The shape test itself is `matchFetchHelperFunction` above, whose body walk is positional —
 * see `matchFetchHelperBody` for why the whole body is accounted for statement by statement
 * rather than probed for known shapes.
 */
export function recognizeFetchHelper(
  statements: readonly AstNode[],
  claims: ClaimSet,
): RecognizedFetchHelper | undefined {
  for (const s of statements) {
    const matched = matchFetchHelperFunction(s, statements);
    if (matched === undefined) continue;
    claims.claim(s, "fetch-helper");
    // The hoisted base's own `const <name> = "…";` is a separate top-level statement (see
    // renderBaseConst) — claim it too, or the totality rule re-blocks the very connector this
    // resolution was meant to unblock, on an unclaimed statement:VariableDeclaration.
    if (matched.constStatement !== undefined) {
      claims.claim(matched.constStatement, "fetch-helper");
    }
    return { fields: matched.fields, passthrough: matched.passthrough };
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
  /** Set only when `base` was hoisted to a module-scope const — see `matchRestUrlConst`. */
  baseConst?: string;
  inlineHeaders?: Record<string, string>;
};

/** `matchRestUrlConst`'s match, plus the hoisted base const's own statement (if any) for the caller to claim alongside the function. */
type MatchedRestUrlConst = {
  readonly base: string;
  readonly baseConst?: string;
  readonly constStatement?: AstNode;
};

/**
 * `const url = path.startsWith("http") ? path : \`<base>${path}\`;` — statement 1 of
 * renderRestKitFetchHelper's body. The ternary shell is read by `passthroughUrlTemplate` above,
 * shared with the hand-style helper's own passthrough statement, which is byte-identical to this
 * one apart from the base expression it wraps; only that base is read here.
 *
 * Two template shapes, both `baseExpr` (src/emit/server/fetch-helper.ts) can write: the LITERAL
 * form (one expression, `path`) and, when `fetchHelper.baseConst` is set, the hoisted form
 * (`` `${baseConst}${path}` ``, two expressions) — discord's `DISCORD_API`, google-meet's
 * `MEET_BASE`. The hoisted identifier is resolved against a top-level
 * `const <name> = "<literal>";` the same way `reconstructBase` above does (see its own comment
 * for why a name that does not resolve to exactly that shape is refused rather than guessed at);
 * `renderRestKitFetchHelper` can only ever produce ONE such identifier here, so anything with
 * more expressions than that is refused, not partially read.
 *
 * `reconstructBase` is deliberately NOT reused for it, unlike the hand-style caller: rest-kit's
 * base cannot carry `${env.X}` at all (ConnectorSpecSchema's rest-kit refine, src/spec.ts, since
 * rest-kit emits no env accessors), so accepting an env-accessor call here would recover a base
 * no rest-kit spec can declare.
 */
function matchRestUrlConst(
  stmt: AstNode,
  statements: readonly AstNode[],
): MatchedRestUrlConst | undefined {
  const alt = templateLiteral(passthroughUrlTemplate(stmt, "path"));
  if (alt === undefined) return undefined;

  // Literal form: `` `<base>${path}` `` — one expression, the path.
  if (alt.expressions.length === 1) {
    if (!isIdent(alt.expressions[0], "path")) return undefined;
    const base = alt.quasis[0];
    if (base === undefined || alt.quasis[1] !== "") return undefined;
    return { base };
  }

  // Hoisted form: `` `${baseConst}${path}` `` — two expressions, no literal text around either
  // (every quasi empty), the second being `path`. Anything else (more expressions, a non-empty
  // quasi) is a shape renderRestKitFetchHelper cannot write and is refused.
  if (alt.expressions.length === 2) {
    if (alt.quasis[0] !== "" || alt.quasis[1] !== "" || alt.quasis[2] !== "") return undefined;
    if (!isIdent(alt.expressions[1], "path")) return undefined;
    const name = identName(alt.expressions[0]);
    const resolved = name === undefined ? undefined : resolveConstString(name, statements);
    if (resolved === undefined) return undefined;
    return { base: resolved.text, baseConst: name, constStatement: resolved.statement };
  }

  return undefined;
}

/**
 * `Authorization: \`Bearer ${token}\`` — the headers object's fixed first entry.
 *
 * The caller guards `isComputedProperty` on the raw property node before this runs (same
 * placement as `restInlineHeaderEntries` and `matchRestFetchOptions` below) — `parts.key` for a
 * computed property (`{ [Authorization]: ... }`) is an Identifier naming the KEY VARIABLE, not
 * the literal "Authorization", and `identName` alone cannot tell the two apart.
 */
function isAuthorizationHeader(parts: { key: AstNode; value: AstNode }): boolean {
  if (identName(parts.key) !== "Authorization") return false;
  const t = templateLiteral(parts.value);
  if (t?.expressions.length !== 1) return false;
  return t.quasis[0] === "Bearer " && t.quasis[1] === "" && isIdent(t.expressions[0], "token");
}

/** `...(init?.headers as Record<string, string> | undefined)` — the headers object's fixed trailing spread. */
function isInitHeadersSpread(node: AstNode): boolean {
  const a = asExpression(spreadArgument(node));
  if (a?.typeAnnotationType !== "TSUnionType") return false;
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
  if (isComputedProperty(first)) return undefined;

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
  if (properties?.length !== 2) return undefined;

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
  if (decl?.name !== "res") return undefined;
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
  if (a?.operator !== "=" || !isIdent(a.left, "json")) return false;
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
  if (tryBody?.length !== 1 || !isJsonAssign(tryBody[0]!, isJsonParseTextAsUnknown)) {
    return false;
  }

  const c = catchClause(t.handler);
  if (c === undefined || c.param !== undefined) return false;
  const handlerBody = blockBody(c.body);
  return handlerBody?.length === 1 && isJsonAssign(handlerBody[0]!, isNullLiteral);
}

/** `return { ok: res.ok, status: res.status, json, text };` — statement 6, matched exactly, in this order. */
function isRestReturnStatement(node: AstNode): boolean {
  const props = objectProps(returnArgument(node));
  if (props?.length !== 4) return false;
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
 * `(token, path, init)` — the rest-kit helper's fixed parameter list, exactly and in this
 * order. This alone separates it from the hand-style read helper, which takes a single `path`
 * (see `recognizeFetchHelper`).
 */
function hasRestFetchHelperParams(fn: AstNode): boolean {
  const params = functionParams(fn);
  return (
    params?.length === 3 &&
    isIdent(params[0], "token") &&
    isIdent(params[1], "path") &&
    isIdent(params[2], "init")
  );
}

/** `matchRestFetchHelperFunction`'s match, plus the hoisted base const's own statement (if any) for the caller to claim alongside the function. */
type MatchedRestFetchHelper = {
  readonly fields: RestFetchHelperFields;
  readonly constStatement?: AstNode;
};

/**
 * One candidate statement, tested as the rest-kit helper: a fixed six-statement body, matched
 * positionally (the same reason `recognizeFetchHelper` above walks its own body positionally
 * rather than `find()`/`walk()`-ing the tree: a claim covers the function's whole byte range, so
 * an extra or reordered statement anywhere inside it must be visible here, not silently
 * swallowed by a shape check that only samples part of the body). Refuses rather than partially
 * reads any step it does not recognize — a wrong `base` regenerates a connector that requests
 * the wrong host and byte-matches nothing, and the failure would look like a formatting problem
 * rather than what it is. Claims nothing itself: a partial match must leave the ClaimSet
 * untouched.
 *
 * `statements` is the module's top-level statement list, threaded through only so
 * `matchRestUrlConst` can resolve a hoisted base identifier against it.
 */
function matchRestFetchHelperFunction(
  s: AstNode,
  statements: readonly AstNode[],
): MatchedRestFetchHelper | undefined {
  if (s.type !== "FunctionDeclaration" || !isAsyncFunction(s)) return undefined;
  if (!hasRestFetchHelperParams(s)) return undefined;

  const body = functionBody(s);
  if (body?.length !== 6) return undefined;

  const url = matchRestUrlConst(body[0]!, statements);
  if (url === undefined) return undefined;

  const headers = matchRestFetchStatement(body[1]!);
  if (headers === undefined) return undefined;

  if (!isTextStatement(body[2]!)) return undefined;
  if (uninitializedLet(body[3]!) !== "json") return undefined;
  if (!isRestJsonTryCatch(body[4]!)) return undefined;
  if (!isRestReturnStatement(body[5]!)) return undefined;

  const local = functionName(s);
  if (local === undefined || local === "") return undefined;

  return {
    fields: {
      local,
      base: url.base,
      ...(url.baseConst === undefined ? {} : { baseConst: url.baseConst }),
      ...(headers.inlineHeaders !== undefined ? { inlineHeaders: headers.inlineHeaders } : {}),
    },
    constStatement: url.constStatement,
  };
}

/**
 * The inverse of renderRestKitFetchHelper. The shape test itself is
 * `matchRestFetchHelperFunction` above; this loop carries only the claim(s) of the first
 * statement that matches it.
 */
export function recognizeRestFetchHelper(
  statements: readonly AstNode[],
  claims: ClaimSet,
): RestFetchHelperFields | undefined {
  for (const s of statements) {
    const matched = matchRestFetchHelperFunction(s, statements);
    if (matched === undefined) continue;
    claims.claim(s, "rest-fetch-helper");
    // Same reasoning as recognizeFetchHelper above: the hoisted base's own
    // `const <name> = "…";` is a separate top-level statement and must be claimed too, or the
    // totality rule re-blocks the connector on it.
    if (matched.constStatement !== undefined) {
      claims.claim(matched.constStatement, "rest-fetch-helper");
    }
    return matched.fields;
  }
  return undefined;
}
