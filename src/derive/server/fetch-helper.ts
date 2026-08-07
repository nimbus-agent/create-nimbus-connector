import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import {
  asExpression,
  assignment,
  awaited,
  bareKeyedProps,
  binary,
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
  functionReturnType,
  IDENTIFIER_KEY_RE,
  identName,
  identTypeAnnotation,
  ifStatement,
  isAsyncFunction,
  isComputedProperty,
  isIdent,
  isNullLiteral,
  isShorthandProperty,
  logical,
  memberOn,
  methodCallTo,
  objectExpressionProperties,
  objectProperty,
  optionalMemberName,
  optionalMemberObject,
  quoteMinimalProps,
  returnArgument,
  spreadArgument,
  stringLit,
  templateLiteral,
  tryStatement,
  typeAnnotationName,
  typeArguments,
  unary,
  uninitializedLet,
  unionTypes,
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
  pathVar: string,
): ReconstructedBase | undefined {
  const t = templateLiteral(template);
  if (t === undefined) return undefined;
  const { quasis, expressions } = t;

  // The last expression is the path variable — pinned to the one this helper actually declares
  // (`pathPart` when it normalizes a leading slash, `path` otherwise), not merely "some
  // identifier". Accepting any name recovers byte-identical fields from a helper that
  // interpolates something else entirely and re-emits a URL it never requested: a wrong claim
  // rather than a rejection. Drop it and the trailing quasi.
  if (expressions.length === 0 || quasis.length === 0) return undefined;
  if (!isIdent(expressions.at(-1), pathVar)) return undefined;

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
 * An object literal read wholesale as `inlineHeaders` — the shape `headerOption`
 * (src/emit/server/fetch-helper.ts) writes when the spec sets that field.
 *
 * Parsed via `quoteMinimalProps`, so any entry it cannot resolve — a spread, a computed key, e.g.
 * `{ ...common, "X-Api-Key": k }` — rejects the WHOLE object rather than being skipped: unlike
 * `findObjectProperty`'s search over the outer fetch-options list, every entry here is meant to
 * become a header. An empty object is refused too, since `FetchHelperSchema` never carries an
 * empty `inlineHeaders` and the accessor form is what its absence actually looks like.
 *
 * The spelling pin is `quoteMinimalProps`, not `bareKeyedProps`: `headerOption` and
 * `renderRestKitFetchHelper` (src/emit/server/fetch-helper.ts) both write a header name bare
 * exactly when `IDENTIFIER_RE` accepts it, so `"X-Api-Key"` — newrelic's, and one of the four
 * byte-locked fixtures' — MUST arrive quoted, while `"Accept"` quoted is a spelling neither
 * emitter can produce. Reading `key` alone accepted both and re-emitted whichever the rule says.
 *
 * Shared by both helpers, which differ only in where the object arrives from: the read helper's
 * `headers:` option value (`inlineHeadersObject` below) and the write helper's
 * `{ ...<headerExpr>, "Content-Type": … }` spread argument (`matchWriteHelperHeaders`). The same
 * share-the-shell rule `isJsonTryCatch` and `passthroughUrlTemplate` follow in this file — a copy
 * is a place for one side to be tightened while the other keeps accepting what its twin just
 * learned to reject.
 */
function headerFields(node: AstNode | undefined): Record<string, string> | undefined {
  const entries = quoteMinimalProps(node);
  if (entries === undefined || entries.length === 0) return undefined;

  const out: Record<string, string> = {};
  for (const entry of entries) {
    const value = headerValue(entry.value);
    if (value === undefined) return undefined;
    out[entry.key] = value;
  }
  return out;
}

/** The read helper's `headers: { … }` option value, as header fields — see `headerFields`. */
function inlineHeadersObject(fetchCall: AstNode): Record<string, string> | undefined {
  const options = callArgs(fetchCall)?.[1];
  const properties = objectExpressionProperties(options) ?? [];
  const headers = findObjectProperty(properties, "headers");
  return headerFields(objectProperty(headers)?.value);
}

/** An env accessor called for its header record, and whether the call site awaits it. */
type AccessorCall = { readonly name: string; readonly awaited: boolean };

/**
 * `<accessor>()` or `await <accessor>()` — the two forms `headerOption` (src/emit/server/
 * fetch-helper.ts) writes for `fetchHelper.headers`, depending on the named env entry's `auth`.
 *
 * WHICH form appears is not a `fetchHelper` field: `headerOption` awaits exactly when that entry
 * carries `auth: "client-credentials"`, whose accessor `renderClientCredentials` emits `async`.
 * So `awaited` is EVIDENCE about the env, handed up to `deriveSharedStyleSpec` and cross-checked
 * there — a module awaiting a synchronous accessor (or failing to await an async one) regenerates
 * the other form, which is a claim this recognizer must not make on its own.
 *
 * Zero arguments is required, not the accessor's identity — `matchFetchHelperFunction` and
 * `matchWriteHelperFunction` both pin `countFetchCalls(s) === 1`, which is what stops
 * `{ ...fetch(), … }` (and now `{ ...(await fetch()), … }`, since `walk` finds the CallExpression
 * inside the AwaitExpression just the same) from recovering `fetchHelper.headers: "fetch"`.
 */
function accessorCall(node: AstNode | undefined): AccessorCall | undefined {
  const inner = awaited(node);
  const call = inner ?? node;
  if (callArgs(call)?.length !== 0) return undefined;
  const name = identName(calleeOf(call));
  return name === undefined ? undefined : { name, awaited: inner !== undefined };
}

/**
 * Extract the headers accessor from the CallExpression form.
 * For `{ headers: headers() }` or `{ headers: await authHeaders() }` — see `accessorCall`.
 */
function headersAccessor(fetchCall: AstNode): AccessorCall | undefined {
  const options = callArgs(fetchCall)?.[1];
  const properties = objectExpressionProperties(options) ?? [];
  const headers = findObjectProperty(properties, "headers");
  return accessorCall(objectProperty(headers)?.value);
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
 * `renderWriteHelper` writes the same statement under the same gate, and `matchWriteHelperBody`
 * below is now its third caller — the one this docstring recorded as missing. It always passes
 * `"path"`: the write helper has no `pathPart` form to rename it to.
 *
 * `pathVar` is a parameter because the hand-style READ helper renames it: `renderFetchHelper`
 * writes the passthrough over `pathPart` when `normalizeLeadingSlash` also asked for that const,
 * and over `path` otherwise. All THREE of its occurrences are pinned to it — the test's receiver,
 * the consequent, and the base template's own trailing interpolation.
 *
 * The third is deliberate duplication, not sole protection, and the distinction is worth stating
 * because it changed under this very fix round. It was written when `reconstructBase` required
 * that last expression to be *an* identifier without saying WHICH — so a helper guarding
 * `pathPart` and then interpolating the un-normalized `path` recovered byte-identical fields and
 * re-emitted a helper fetching a different URL. `reconstructBase` now pins `pathVar` itself, and
 * `matchRestUrlConst` has always pinned the literal `"path"` for rest-kit, so all THREE of this
 * function's callers are now covered downstream: the hand-rolled read helper by `reconstructBase`,
 * rest-kit by `matchRestUrlConst`, and `matchWriteHelperBody` by construction, since it can only
 * ever pass the literal `"path"`. The check stays because a recognizer that
 * validates part of a construct and claims the whole of it is this module's recurring defect, and
 * the two sides being able to drift apart is the reason `hoists.ts` exists — but it is defence in
 * depth now, and a reader must not take it for the only thing standing between the two shapes.
 */
function passthroughUrlTemplate(stmt: AstNode, pathVar: string): AstNode | undefined {
  const decl = constDecl(stmt);
  if (decl?.name !== "url") return undefined;

  const c = conditional(decl.init);
  if (c === undefined) return undefined;
  if (!startsWithLiteral(c.test, pathVar, "http")) return undefined;
  if (!isIdent(c.consequent, pathVar)) return undefined;

  const t = templateLiteral(c.alternate);
  if (t === undefined || !isIdent(t.expressions.at(-1), pathVar)) return undefined;
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
 *
 * Exported for `server/env.ts`'s client-credentials token exchange, which writes the identical
 * line: `renderTokenFunction` (src/emit/server/env.ts) performs its own fetch, and this is the
 * fourth emitter function to write this statement. Shared rather than copied, the rule
 * `hoists.ts`'s module docstring states — a copy is a place for one side to be tightened while
 * the other keeps accepting what its twin just learned to reject.
 */
export function isTextStatement(stmt: AstNode): boolean {
  const decl = constDecl(stmt);
  if (decl?.name !== "text") return false;
  const call = awaited(decl.init);
  return methodCallTo(call, "res", "text", 0) !== undefined;
}

/**
 * `if (!res.ok) { throw new Error(...); }` — matched positionally. The throw's message
 * (serviceLabel) is read separately, by serviceLabelFrom against the whole function: with the
 * body now fully accounted for statement by statement, this is the only throw left in it.
 *
 * Exported for the same reason `isTextStatement` above is: `renderTokenFunction`
 * (src/emit/server/env.ts) writes this identical guard around its own response. That caller reads
 * the message rather than ignoring it — its token function throws TWO messages, and they have to
 * name the same service — so it checks the SHELL here and digs the template out itself, which is
 * why this still returns a bare boolean.
 */
export function isThrowGuard(stmt: AstNode): boolean {
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
 * `try { return JSON.parse(text) as unknown; } catch { <fallback> }` — the closing try/catch
 * shell, pinned exactly: a bare `catch` (no binding), a one-statement try block, a one-statement
 * catch block, no finally. Anything else with a TryStatement in this position (a caught binding,
 * extra statements) is not this shape and is refused rather than approximated.
 *
 * `fallback` is the one clause that differs between the two emitters that write this shell:
 * `return { raw: text };` for `renderFetchHelper`'s jsonFallbackRaw form, `return null;` for
 * `renderWriteHelper`'s (which has no spec field and always writes it). Shared rather than
 * copied — a copy is a place for one side to be tightened while the other keeps accepting what
 * its twin just learned to reject, the rule hoists.ts's module docstring states.
 */
function isJsonTryCatch(node: AstNode, fallback: (statement: AstNode) => boolean): boolean {
  const t = tryStatement(node);
  if (t === undefined || t.finalizer !== undefined) return false;

  const tryBody = blockBody(t.block);
  if (tryBody?.length !== 1 || !isPlainJsonReturn(tryBody[0]!)) {
    return false;
  }

  const c = catchClause(t.handler);
  if (c === undefined || c.param !== undefined) return false;
  const handlerBody = blockBody(c.body);
  return handlerBody?.length === 1 && fallback(handlerBody[0]!);
}

/** The jsonFallbackRaw: true form — `renderFetchHelper`'s only alternative ending. */
function isJsonFallbackTry(node: AstNode): boolean {
  return isJsonTryCatch(node, isRawFallbackReturn);
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
  // them apart from the `normalizeLeadingSlash: true` shape `grafana` is the only fixture to set.
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
 * The recovered headers, split the way `RecognizedFetchHelper` splits its own result: the spec
 * fields, and the one recovered fact that is NOT one. See `accessorCall` for what `awaitedHeaders`
 * means and why it cannot be resolved here.
 */
type MatchedHeaders = { readonly fields: FetchHelperHeaders; readonly awaitedHeaders: boolean };

/**
 * The headers half of the fetch options object. `renderFetchHelper` writes exactly one of the
 * two forms, so both present at once (or neither) is refused rather than resolved in favour of
 * one of them. The inline form is never awaited — `headerOption`'s inline branch writes each
 * value as a literal or a bare `${env.X}` accessor call, with no `await` anywhere.
 */
function matchFetchHelperHeaders(fetchCall: AstNode): MatchedHeaders | undefined {
  const inlineHeaders = inlineHeadersObject(fetchCall);
  const headers = headersAccessor(fetchCall);
  if (inlineHeaders !== undefined && headers !== undefined) return undefined;
  if (inlineHeaders !== undefined) return { fields: { inlineHeaders }, awaitedHeaders: false };
  if (headers === undefined) return undefined;
  return { fields: { headers: headers.name }, awaitedHeaders: headers.awaited };
}

/** `matchFetchHelperFunction`'s match, plus the hoisted base const's own statement (if any) for the caller to claim alongside the function. */
type MatchedFetchHelper = {
  readonly fields: FetchHelperFields;
  readonly constStatement?: AstNode;
  /** See `FetchHelperBody.passthrough` — evidence about the tools, not a `fetchHelper` field. */
  readonly passthrough: boolean;
  /** See `accessorCall` — evidence about the env, not a `fetchHelper` field. */
  readonly awaitedHeaders: boolean;
};

/**
 * What `recognizeFetchHelper` hands back: the spec fields, and the two pieces of recovered
 * evidence that are NOT fields. Kept beside `fields` rather than folded into `FetchHelperFields`
 * for the same reason tools-hand.ts's `ToolShape` keeps `staticStyle`/`schemaShape` beside its own
 * `fields` — `FetchHelperSchema` is a `strictObject` that would reject a `passthrough` key, and
 * `deriveSharedStyleSpec` spreads these fields straight into the derived spec.
 */
export type RecognizedFetchHelper = {
  readonly fields: FetchHelperFields;
  readonly passthrough: boolean;
  readonly awaitedHeaders: boolean;
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

  const pathVar = parsed.normalizeLeadingSlash ? "pathPart" : "path";
  const reconstructed = reconstructBase(parsed.baseTemplate, statements, pathVar);
  const serviceLabel = serviceLabelFrom(s);
  const local = functionName(s) ?? "";
  if (reconstructed === undefined || serviceLabel === undefined || local === "") return undefined;

  return {
    fields: {
      local,
      base: reconstructed.base,
      ...(reconstructed.baseConst === undefined ? {} : { baseConst: reconstructed.baseConst }),
      serviceLabel,
      ...headers.fields,
      ...(parsed.normalizeLeadingSlash && { normalizeLeadingSlash: true as const }),
      ...(parsed.jsonFallbackRaw && { jsonFallbackRaw: true as const }),
    },
    constStatement: reconstructed.constStatement,
    passthrough: parsed.passthrough,
    awaitedHeaders: headers.awaitedHeaders,
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
    return {
      fields: matched.fields,
      passthrough: matched.passthrough,
      awaitedHeaders: matched.awaitedHeaders,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The write helper — renderWriteHelper (src/emit/server/fetch-helper.ts), emitted IFF some tool
// is non-GET and the style is not rest-kit. `recognizeFetchHelper` above cannot see it: that one
// requires exactly one parameter named `path`, and this takes three.
//
// It carries no `fetchHelper` field of its OWN — every line is derived from `fetchHelper`,
// `serviceLabel` and the presence of a non-GET tool — so when the read helper is also present it
// is claimed-and-verified and recovers nothing new. But `renderReadHelper` emits nothing at all
// for a connector whose every tool is a write (see its own docstring: a read helper nothing calls
// is a TS6133 in the generated package), and `zzwriteonly` is exactly that shape. For those, this
// function is the module's ONLY source of `local`, `base`, `baseConst`, `serviceLabel` and the
// headers, so it recovers them — and `deriveSharedStyleSpec` cross-checks the two against each
// other whenever both exist rather than letting either quietly win.
//
// Two `FetchHelperSchema` fields are NOT recoverable here, and their absence is byte-safe rather
// than a gap: `normalizeLeadingSlash` and `jsonFallbackRaw` both change only the READ helper's
// text (`renderWriteHelper` never normalizes a leading slash, and always writes the `null`
// fallback), so a write-only connector re-emits identically whether they were set or not. They
// are unobservable in such a module, not lost from it.
// ---------------------------------------------------------------------------

/** The suffix `renderWriteHelper` appends to `fetchHelper.local` — the write helper's whole name. */
const WRITE_SUFFIX = "Send";

/**
 * `(path: string, method: string, body: string | undefined)`, and `): Promise<unknown>`.
 *
 * Pinned by TYPE as well as by name, unlike the read helper's single `path` parameter — this
 * function claims a whole FunctionDeclaration on the strength of its name and body, and a
 * `body: string` where the emitter writes `body: string | undefined` re-emits different bytes
 * while every recovered field stays identical. The return type is pinned all the way through its
 * ARGUMENT for the same reason: `Promise<void>` shares the head name `typeAnnotationName` reports,
 * and is a return type `renderWriteHelper` never writes.
 */
function hasWriteHelperSignature(fn: AstNode): boolean {
  const params = functionParams(fn);
  if (params?.length !== 3) return false;
  if (!isIdent(params[0], "path") || !isIdent(params[1], "method")) return false;
  if (!isIdent(params[2], "body")) return false;
  if (typeAnnotationName(identTypeAnnotation(params[0])) !== "string") return false;
  if (typeAnnotationName(identTypeAnnotation(params[1])) !== "string") return false;

  const bodyType = unionTypes(identTypeAnnotation(params[2]));
  if (bodyType?.length !== 2) return false;
  if (typeAnnotationName(bodyType[0]) !== "string") return false;
  if (typeAnnotationName(bodyType[1]) !== "undefined") return false;

  const returnType = functionReturnType(fn);
  if (typeAnnotationName(returnType) !== "Promise") return false;
  const resolved = typeArguments(returnType);
  return resolved?.length === 1 && typeAnnotationName(resolved[0]) === "unknown";
}

/**
 * `...(body === undefined ? {} : { body })` — the fetch options object's fixed trailing spread,
 * every part pinned. The alternate's `{ body }` is required to be SHORTHAND: the emitter writes
 * it that way literally, and `{ body: body }` is a different output no spec produces.
 */
function isConditionalBodySpread(node: AstNode): boolean {
  const c = conditional(spreadArgument(node));
  if (c === undefined) return false;

  const test = binary(c.test);
  if (test?.operator !== "===") return false;
  if (!isIdent(test.left, "body") || !isIdent(test.right, "undefined")) return false;

  if (objectExpressionProperties(c.consequent)?.length !== 0) return false;
  const alternate = objectExpressionProperties(c.alternate);
  const only = alternate?.length === 1 ? alternate[0] : undefined;
  if (only === undefined || isComputedProperty(only) || !isShorthandProperty(only)) return false;
  return isIdent(objectProperty(only)?.key, "body");
}

/**
 * `{ ...<headerExpr>, "Content-Type": "application/json" }` — the write helper's headers object,
 * and the header fields its spread carries.
 *
 * `headerExpr` is `headerOption(spec)` with the `headers: ` prefix stripped, so the spread's
 * argument is exactly one of the two forms the READ helper puts after `headers:` — an inline
 * object literal, or a (possibly awaited) zero-argument accessor call, read by the same
 * `accessorCall` the read side uses.
 *
 * The `await headers()` form used to be refused here, and that refusal was correct only because
 * `recognizeEnv` did not yet model the accessor that produces it: `auth: "client-credentials"`.
 * Task 8 landed that recognizer, which makes the shape reachable — so the check became a cross-
 * check rather than a refusal, and it moved to `deriveSharedStyleSpec`, the only place that can
 * see both this helper and the env entry `fetchHelper.headers` names.
 */
function matchWriteHelperHeaders(node: AstNode): MatchedHeaders | undefined {
  const properties = objectExpressionProperties(node);
  if (properties?.length !== 2) return undefined;

  const spread = spreadArgument(properties[0]!);
  if (spread === undefined) return undefined;

  const contentType = properties[1]!;
  if (isComputedProperty(contentType)) return undefined;
  const parts = objectProperty(contentType);
  if (parts === undefined) return undefined;
  if (stringLit(parts.key) !== "Content-Type") return undefined;
  if (stringLit(parts.value) !== "application/json") return undefined;

  // The inline form, through the same `headerFields` the read helper's own option value goes
  // through. Discriminated on the spread argument being an object AT ALL, rather than on
  // `headerFields` succeeding: an object literal this recognizer cannot read must refuse here,
  // not fall through to the accessor branch and be refused there for an unrelated reason.
  if (objectExpressionProperties(spread) !== undefined) {
    const inlineHeaders = headerFields(spread);
    return inlineHeaders === undefined
      ? undefined
      : { fields: { inlineHeaders }, awaitedHeaders: false };
  }

  const headers = accessorCall(spread);
  if (headers === undefined) return undefined;
  return { fields: { headers: headers.name }, awaitedHeaders: headers.awaited };
}

/**
 * `{ method, headers: { … }, ...(body === undefined ? {} : { body }) }` — exactly these three
 * entries, in this order. `method` is required to be SHORTHAND for the same reason `{ body }` is.
 */
function matchWriteHelperOptions(node: AstNode): MatchedHeaders | undefined {
  const properties = objectExpressionProperties(node);
  if (properties?.length !== 3) return undefined;

  const method = properties[0]!;
  if (isComputedProperty(method) || !isShorthandProperty(method)) return undefined;
  if (!isIdent(objectProperty(method)?.key, "method")) return undefined;

  const headers = properties[1]!;
  if (isComputedProperty(headers)) return undefined;
  const headerParts = objectProperty(headers);
  if (headerParts === undefined || !isIdent(headerParts.key, "headers")) return undefined;

  if (!isConditionalBodySpread(properties[2]!)) return undefined;
  return matchWriteHelperHeaders(headerParts.value);
}

/** What `matchWriteHelperBody` recovers from the write helper's statement sequence. */
type WriteHelperBody = {
  /** The template `reconstructBase` reads the base off — see `FetchHelperBody.baseTemplate`. */
  readonly baseTemplate: AstNode;
  readonly headers: MatchedHeaders;
  /** See `FetchHelperBody.passthrough`: evidence about the tools, not a `fetchHelper` field. */
  readonly passthrough: boolean;
};

/**
 * The write helper's body, walked positionally for the reason `matchFetchHelperBody` documents:
 * `claims.claim(s, …)` claims the function's whole byte range, so every statement inside it has
 * to be accounted for here or an inserted one is silently covered along with it.
 *
 * The optional passthrough const always guards `path` — `renderWriteHelper` has no `pathPart`
 * form, so unlike the read helper there is no `pathVar` to choose. It is `passthroughUrlTemplate`
 * that reads it, shared with the read helper and the rest-kit helper: Task 4 left this caller
 * unwritten and said so in that function's own docstring, which is why the parameter was already
 * there.
 */
function matchWriteHelperBody(body: readonly AstNode[]): WriteHelperBody | undefined {
  let idx = 0;

  const passthroughTemplate =
    idx < body.length ? passthroughUrlTemplate(body[idx]!, "path") : undefined;
  const passthrough = passthroughTemplate !== undefined;
  if (passthrough) idx++;

  const fetchCall = idx < body.length ? matchFetchStatement(body[idx]!) : undefined;
  if (fetchCall === undefined) return undefined;
  idx++;

  const args = callArgs(fetchCall);
  const fetchUrl = args?.[0];
  const options = args?.[1];
  if (fetchUrl === undefined || options === undefined) return undefined;
  // Same pin as the read helper's: with the passthrough const in front of it the emitter passes
  // that const's own binding, so a helper fetching something else would be recorded with a base
  // it never actually requests.
  if (passthrough && !isIdent(fetchUrl, "url")) return undefined;

  const headers = matchWriteHelperOptions(options);
  if (headers === undefined) return undefined;

  if (idx >= body.length || !isTextStatement(body[idx]!)) return undefined;
  idx++;

  if (idx >= body.length || !isThrowGuard(body[idx]!)) return undefined;
  idx++;

  // Exactly one statement left, and only one shape it can be: renderWriteHelper's tail has no
  // spec field to vary it, unlike the read helper's jsonFallbackRaw pair.
  if (body.length - idx !== 1) return undefined;
  if (!isJsonTryCatch(body[idx]!, (s) => isNullLiteral(returnArgument(s)))) return undefined;

  return { baseTemplate: passthroughTemplate ?? fetchUrl, headers, passthrough };
}

/** `matchWriteHelperFunction`'s match, plus the hoisted base const's own statement (if any) for the caller to claim alongside the function. */
type MatchedWriteHelper = {
  readonly fields: FetchHelperFields;
  readonly constStatement?: AstNode;
  readonly passthrough: boolean;
  /** See `accessorCall` — evidence about the env, not a `fetchHelper` field. */
  readonly awaitedHeaders: boolean;
};

/**
 * One candidate statement, tested as the write helper. Claims nothing itself: a partial match
 * must leave the ClaimSet untouched.
 *
 * Recognized by NAME as well as shape, unlike the read helper — `renderWriteHelper` writes
 * `${fh.local}Send` and nothing else, and the suffix is what the local is recovered from when
 * there is no read helper to take it from.
 */
function matchWriteHelperFunction(
  s: AstNode,
  statements: readonly AstNode[],
): MatchedWriteHelper | undefined {
  if (s.type !== "FunctionDeclaration" || !isAsyncFunction(s)) return undefined;

  const name = functionName(s);
  if (name === undefined || !name.endsWith(WRITE_SUFFIX)) return undefined;
  const local = name.slice(0, -WRITE_SUFFIX.length);
  // `FetchHelperSchema` keeps `local` non-empty, so a function named exactly "Send" is not a
  // write helper any spec produces.
  if (local === "") return undefined;

  if (!hasWriteHelperSignature(s)) return undefined;

  // The same guard the read helper carries, applied here for the same reason and against a real
  // hole rather than for symmetry: `matchWriteHelperHeaders`' accessor branch accepts any
  // zero-argument call, and `fetch()` is one — so `{ ...fetch(), "Content-Type": … }` would
  // otherwise recover `fetchHelper.headers: "fetch"`. That spec re-emits the identical bytes, so
  // no byte-diff could ever see it; it is the wrong-claim class, invisible to the totality rule
  // because the statement IS claimed, just claimed wrongly.
  if (countFetchCalls(s) !== 1) return undefined;

  const parsed = matchWriteHelperBody(functionBody(s) ?? []);
  if (parsed === undefined) return undefined;

  const reconstructed = reconstructBase(parsed.baseTemplate, statements, "path");
  const serviceLabel = serviceLabelFrom(s);
  if (reconstructed === undefined || serviceLabel === undefined) return undefined;

  return {
    fields: {
      local,
      base: reconstructed.base,
      ...(reconstructed.baseConst === undefined ? {} : { baseConst: reconstructed.baseConst }),
      serviceLabel,
      ...parsed.headers.fields,
    },
    constStatement: reconstructed.constStatement,
    passthrough: parsed.passthrough,
    awaitedHeaders: parsed.headers.awaitedHeaders,
  };
}

/**
 * Every field the two helpers must agree on, held against each other.
 *
 * `renderWriteHelper` and `renderFetchHelper` splice in the SAME `fetchHelper.local`, base,
 * `serviceLabel` and `headerOption(spec)`, so a module where the two disagree is one the emitter
 * cannot have written, and claiming it would derive a spec that regenerates neither. The read
 * helper is the authority — this compares rather than choosing — which is why
 * `deriveSharedStyleSpec` goes on to spread the READ helper's fields into the spec even when both
 * were recognized. Two recognizers producing one fact independently is how they drift, and this
 * branch has already found that exact defect twice (`rest-fetch-helper-name-mismatch`, and the
 * query base prefix).
 *
 * `inlineHeaders` is compared through `JSON.stringify` rather than key by key because ORDER is
 * part of the fact: both helpers render `headerOption(spec)`'s entries in one `Object.entries`
 * pass, so a reordering is a module neither of them wrote.
 *
 * `awaitedHeaders` is deliberately NOT compared here, and it is not a hole: it is evidence about
 * the ENV rather than a `fetchHelper` field (see `accessorCall`), and `deriveSharedStyleSpec`
 * holds EACH helper's flag against the env entry independently. Two helpers disagreeing means at
 * least one of them disagrees with the env, so that check already blocks the module — comparing
 * them here as well would name the same defect twice, and less precisely.
 */
function agreesWithReadHelper(write: FetchHelperFields, read: FetchHelperFields): boolean {
  return (
    write.local === read.local &&
    write.base === read.base &&
    write.baseConst === read.baseConst &&
    write.serviceLabel === read.serviceLabel &&
    write.headers === read.headers &&
    JSON.stringify(write.inlineHeaders) === JSON.stringify(read.inlineHeaders)
  );
}

/** What `recognizeWriteHelper` hands back — the same split `RecognizedFetchHelper` documents. */
export type RecognizedWriteHelper = {
  readonly fields: FetchHelperFields;
  readonly passthrough: boolean;
  readonly awaitedHeaders: boolean;
};

/**
 * The write helper, as src/emit/server/fetch-helper.ts writes it — see this section's header for
 * what it recovers and when.
 *
 * `readHelper` is whatever `recognizeFetchHelper` recovered from the same module, or undefined
 * when it recovered nothing. Present and disagreeing is a refusal rather than a preference: see
 * `agreesWithReadHelper`. Refusing leaves the function unclaimed, so the totality rule reports it
 * by name (`function:<local>Send`) instead of the module deriving a spec for a shape it cannot
 * reproduce.
 */
export function recognizeWriteHelper(
  statements: readonly AstNode[],
  claims: ClaimSet,
  readHelper: FetchHelperFields | undefined,
): RecognizedWriteHelper | undefined {
  for (const s of statements) {
    const matched = matchWriteHelperFunction(s, statements);
    if (matched === undefined) continue;
    if (readHelper !== undefined && !agreesWithReadHelper(matched.fields, readHelper)) {
      return undefined;
    }
    claims.claim(s, "write-helper");
    // Same reasoning as recognizeFetchHelper's: the hoisted base's own `const <name> = "…";` is a
    // separate top-level statement and must be claimed too, or the totality rule re-blocks the
    // connector on it. Claiming it twice when the read helper already did is harmless — claims
    // are byte ranges and coverage is containment (claims.ts), not a set of owners.
    if (matched.constStatement !== undefined) {
      claims.claim(matched.constStatement, "write-helper");
    }
    return {
      fields: matched.fields,
      passthrough: matched.passthrough,
      awaitedHeaders: matched.awaitedHeaders,
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
 *
 * The key spelling is `quoteMinimalProps`' rule (src/derive/read.ts) applied per key rather than
 * through that wrapper, because these properties arrive already sliced out of a list whose first
 * and last entries are the fixed `Authorization` header and the `...init?.headers` spread — a
 * spread `objectProps` refuses outright. `renderRestKitFetchHelper` writes each extra header as
 * `IDENTIFIER_RE.test(k) ? k : JSON.stringify(k)`, so `"X-Api-Version"` MUST arrive quoted and a
 * quoted `"Accept"` is a spelling it cannot produce — and, since the recovered `inlineHeaders`
 * record is identical either way, one that re-emits different bytes with no gate able to see it.
 */
function restInlineHeaderEntries(
  properties: readonly AstNode[],
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const property of properties) {
    if (isComputedProperty(property)) return undefined;
    const parts = objectProperty(property);
    if (parts === undefined) return undefined;
    const bare = identName(parts.key);
    const key = bare ?? stringLit(parts.key);
    const value = stringLit(parts.value);
    if (key === undefined || value === undefined) return undefined;
    if ((bare !== undefined) !== IDENTIFIER_KEY_RE.test(key)) return undefined;
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

/**
 * `return { ok: res.ok, status: res.status, json, text };` — statement 6, matched exactly, in this
 * order, and with all four keys bare: `renderRestKitFetchHelper` hardcodes that line, so
 * `{ "ok": res.ok, … }` recovers the same nothing (this function returns a boolean; the envelope
 * carries no spec field at all) while re-emitting the bare form.
 */
function isRestReturnStatement(node: AstNode): boolean {
  const props = bareKeyedProps(returnArgument(node));
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
