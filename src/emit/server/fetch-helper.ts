import type { ConnectorSpec } from "../../spec.ts";

/** Replace ${env.X} with X() inside a base or header template. */
function resolveEnvRefs(tpl: string): string {
  return tpl.replaceAll(/\$\{env\.(\w+)\}/g, "${$1()}");
}

/**
 * The module-scope base const, or undefined when the spec does not ask for one — or when
 * nothing would read it.
 *
 * Emitted ahead of the env accessors (see emitServer), which is where mercury's `BASE` and
 * bitrise's `BITRISE_API` sit. FetchHelperSchema guarantees `base` is fully static here, so
 * no resolveEnvRefs() call is needed or reachable.
 *
 * Gated on the helpers for exactly the reason renderReadHelper and usesJsonResult are: the
 * const is referenced only from a fetch helper's URL template, so a spec that declares
 * `baseConst` and whose tools are all stubs would emit a module-scope const nothing reads —
 * a TS6133 under the generated package's own `noUnusedLocals` and a `noUnusedVariables`
 * error under its biome.json. The question is asked of the two functions that decide rather
 * than restated, so the gate cannot drift from what is actually emitted.
 */
export function renderBaseConst(spec: ConnectorSpec): string | undefined {
  const { baseConst, base } = spec.fetchHelper;
  if (baseConst === undefined) return undefined;
  const emitsHelper = renderReadHelper(spec) !== undefined || renderWriteHelper(spec) !== undefined;
  return emitsHelper ? `const ${baseConst} = ${JSON.stringify(base)};` : undefined;
}

/**
 * The base as it appears INSIDE a template literal — `${BASE}` when hoisted, the resolved
 * literal otherwise. One helper so the read helper, the write helper and the rest-kit
 * helper cannot disagree about which form they use.
 */
export function baseExpr(spec: ConnectorSpec): string {
  const { baseConst, base } = spec.fetchHelper;
  return baseConst === undefined ? resolveEnvRefs(base) : `\${${baseConst}}`;
}

/**
 * Whether any tool in this spec declares "query" — the only shape whose handler/buildPath
 * callback (tools-hand.ts / tools-rest.ts) returns an ABSOLUTE URL rather than a bare path,
 * to avoid double-prefixing the base (see those files' own comments at the `` `${u}` ``
 * return). `renderFetchHelper` and `renderWriteHelper` below gate their own
 * `path.startsWith("http")` passthrough on this: it is new code neither function needs for a
 * spec with no query tool, and gating on it is what keeps every existing fixture's read/write
 * helper byte-identical. `renderRestKitFetchHelper` needs no such gate — its passthrough
 * predates this feature and was already unconditional.
 */
function hasQueryTool(spec: ConnectorSpec): boolean {
  return spec.tools.some((t) => t.query !== undefined);
}

function headerOption(spec: ConnectorSpec): string {
  const fh = spec.fetchHelper;
  if (fh.inlineHeaders !== undefined) {
    const fields = Object.entries(fh.inlineHeaders)
      .map(([k, v]) => {
        const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
        const inner = /^\$\{env\.\w+\}$/.test(v)
          ? resolveEnvRefs(v).slice(2, -1)
          : JSON.stringify(v);
        return `${key}: ${inner}`;
      })
      .join(", ");
    return `headers: { ${fields} }`;
  }
  // A client-credentials accessor is `async` (it awaits the cached token exchange), so its
  // call must be awaited — every call site of headerOption is itself inside an `async`
  // function ($fh.local and $fh.localSend), so `await` is always valid here. Every other
  // auth mode's accessor is synchronous and unaffected.
  const entry = spec.env.find((e) => e.local === fh.headers);
  const call = entry?.auth === "client-credentials" ? `await ${fh.headers}()` : `${fh.headers}()`;
  return `headers: ${call}`;
}

/**
 * Style R: `makeRestToolRegistrar` resolves the token itself and passes it in, and
 * calls `mcpJsonResultIfOk` on the returned envelope — so this helper takes the token
 * as a parameter and does NOT throw on non-2xx.
 */
function renderRestKitFetchHelper(spec: ConnectorSpec): string {
  const fh = spec.fetchHelper;
  // Both fh.base and fh.inlineHeaders values are guaranteed free of ${env.X} references
  // here — ConnectorSpecSchema's rest-kit refine rejects any such reference at parse
  // time, since rest-kit emits no env accessors and the call would be undefined. No
  // resolveEnvRefs() call is needed or reachable for either.
  const base = baseExpr(spec);
  const extra =
    fh.inlineHeaders === undefined
      ? ""
      : Object.entries(fh.inlineHeaders)
          .map(([k, v]) => {
            const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
            return `      ${key}: ${JSON.stringify(v)},`;
          })
          .join("\n");

  return [
    `async function ${fh.local}(`,
    "  token: string,",
    "  path: string,",
    "  init?: RequestInit,",
    "): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {",
    `  const url = path.startsWith("http") ? path : \`${base}\${path}\`;`,
    "  const res = await fetch(url, {",
    "    ...init,",
    "    headers: {",
    "      Authorization: `Bearer ${token}`,",
    ...(extra === "" ? [] : [extra]),
    "      ...(init?.headers as Record<string, string> | undefined),",
    "    },",
    "  });",
    "  const text = await res.text();",
    "  let json: unknown;",
    "  try {",
    "    json = JSON.parse(text) as unknown;",
    "  } catch {",
    "    json = null;",
    "  }",
    "  return { ok: res.ok, status: res.status, json, text };",
    "}",
  ].join("\n");
}

/**
 * The write helper, or undefined when the spec has no non-GET tool.
 *
 * Emitting it conditionally is what makes Stage C byte-safe: a read-only spec never
 * reaches this function, so newrelic/datadog/grafana/sentry cannot move. It also mirrors
 * the corpus — argocd has agPost because argocd posts.
 */
export function renderWriteHelper(spec: ConnectorSpec): string | undefined {
  if (!spec.tools.some((t) => t.method !== "GET")) return undefined;
  if (spec.style === "rest-kit") return undefined; // the registrar's buildInit carries it

  const fh = spec.fetchHelper;
  const base = baseExpr(spec);
  const passthrough = hasQueryTool(spec);
  const url = passthrough ? "url" : `\`${base}\${path}\``;
  // headerOption(spec) returns "headers: <expr>" where <expr> is either an inline object
  // literal or an accessor call (see FetchHelperSchema — headers and inlineHeaders are
  // mutually exclusive). Strip the "headers: " prefix and spread the expression so the
  // write helper gets the same headers as the read helper, plus Content-Type.
  const headerExpr = headerOption(spec).replace(/^headers: /, "");
  return [
    `async function ${fh.local}Send(`,
    "  path: string,",
    "  method: string,",
    "  body: string | undefined,",
    "): Promise<unknown> {",
    // See hasQueryTool's comment: only reached when a query tool exists, so this is never
    // an extra line in a spec that has none.
    ...(passthrough ? [`  const url = path.startsWith("http") ? path : \`${base}\${path}\`;`] : []),
    `  const res = await fetch(${url}, {`,
    "    method,",
    `    headers: { ...${headerExpr}, "Content-Type": "application/json" },`,
    "    ...(body === undefined ? {} : { body }),",
    "  });",
    "  const text = await res.text();",
    "  if (!res.ok) {",
    `    throw new Error(\`${spec.serviceLabel} \${String(res.status)}: \${text.slice(0, 400)}\`);`,
    "  }",
    "  try {",
    "    return JSON.parse(text) as unknown;",
    "  } catch {",
    "    return null;",
    "  }",
    "}",
  ].join("\n");
}

/**
 * The read helper, or undefined when nothing the emitted server contains would call it.
 *
 * Final fix wave, IMPORTANT 3: the read helper used to be emitted unconditionally, which is
 * exactly the defect `renderWriteHelper`'s own guard above exists to prevent, mirrored. A
 * hand-rolled spec whose only tool is a POST emits `async function <local>(path)` that
 * nothing calls — a write tool routes through `<local>Send`, a different function — and the
 * generated package's own tsconfig (`noUnusedLocals`) and biome.json (`noUnusedVariables`)
 * both reject it. The same holds for a hand-rolled spec that is all stubs, or has no tools:
 * a stub handler only throws.
 *
 * rest-kit is unconditional, and not for symmetry's sake: `makeRestToolRegistrar` is handed
 * the helper as its `fetch:` option, so the factory line references it whatever the tools
 * do — including for a spec with no tools at all.
 *
 * Read-only and mixed specs are unaffected, which is what keeps newrelic/datadog/grafana/
 * sentry byte-identical.
 */
export function renderReadHelper(spec: ConnectorSpec): string | undefined {
  if (spec.style === "rest-kit") return renderFetchHelper(spec);
  const called = spec.tools.some((t) => t.method === "GET" && t.impl !== "stub");
  return called ? renderFetchHelper(spec) : undefined;
}

export function renderFetchHelper(spec: ConnectorSpec): string {
  if (spec.style === "rest-kit") return renderRestKitFetchHelper(spec);

  const fh = spec.fetchHelper;
  const pathVar = fh.normalizeLeadingSlash ? "pathPart" : "path";
  const base = baseExpr(spec);
  const passthrough = hasQueryTool(spec);
  const url = passthrough ? "url" : `\`${base}\${${pathVar}}\``;
  const opts = headerOption(spec);
  // Expanded form (matching grafana/newrelic) iff normalizeLeadingSlash asks for it or the
  // headers are an inline object literal; a bare `headers: headers()` accessor call (datadog,
  // sentry) stays inline. Biome preserves either shape as emitted — this is emitter-controlled.
  const expand = fh.normalizeLeadingSlash || fh.inlineHeaders !== undefined;

  const lines: string[] = [`async function ${fh.local}(path: string): Promise<unknown> {`];

  if (fh.normalizeLeadingSlash) {
    // The `startsWith("http")` arm only matters when a query tool exists (passthrough) —
    // without one `path` is never an absolute URL, so this stays byte-identical to before for
    // every existing fixture. With one, this guard has to run BEFORE the leading-slash rule
    // below: an absolute URL forced through `` `/${path}` `` would emit "/https://...".
    const guard = passthrough
      ? 'path.startsWith("http") || path.startsWith("/")'
      : 'path.startsWith("/")';
    lines.push(`  const pathPart = ${guard} ? path : \`/\${path}\`;`);
  }

  if (passthrough) {
    // See hasQueryTool's comment: mirrors makeRestToolRegistrar's own passthrough so a query
    // tool's absolute-URL return (tools-hand.ts) is used as-is instead of having the base
    // prepended a second time.
    lines.push(
      `  const url = ${pathVar}.startsWith("http") ? ${pathVar} : \`${base}\${${pathVar}}\`;`,
    );
  }

  if (expand) {
    lines.push(`  const res = await fetch(${url}, {`, `    ${opts},`, `  });`);
  } else {
    lines.push(`  const res = await fetch(${url}, { ${opts} });`);
  }

  lines.push(
    "  const text = await res.text();",
    "  if (!res.ok) {",
    `    throw new Error(\`${spec.serviceLabel} \${String(res.status)}: \${text.slice(0, 400)}\`);`,
    "  }",
  );

  if (fh.jsonFallbackRaw) {
    lines.push(
      "  try {",
      "    return JSON.parse(text) as unknown;",
      "  } catch {",
      "    return { raw: text };",
      "  }",
    );
  } else {
    lines.push("  return JSON.parse(text) as unknown;");
  }

  lines.push("}");
  return lines.join("\n");
}
