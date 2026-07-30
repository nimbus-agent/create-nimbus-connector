import type { ConnectorSpec } from "../../spec.ts";

/** Replace ${env.X} with X() inside a base or header template. */
function resolveEnvRefs(tpl: string): string {
  return tpl.replaceAll(/\$\{env\.([A-Za-z0-9_]+)\}/g, "${$1()}");
}

function headerOption(spec: ConnectorSpec): string {
  const fh = spec.fetchHelper;
  if (fh.inlineHeaders !== undefined) {
    const fields = Object.entries(fh.inlineHeaders)
      .map(([k, v]) => {
        const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
        const inner = /^\$\{env\.[A-Za-z0-9_]+\}$/.test(v)
          ? resolveEnvRefs(v).slice(2, -1)
          : JSON.stringify(v);
        return `${key}: ${inner}`;
      })
      .join(", ");
    return `headers: { ${fields} }`;
  }
  return `headers: ${fh.headers}()`;
}

/**
 * Style R: `makeRestToolRegistrar` resolves the token itself and passes it in, and
 * calls `mcpJsonResultIfOk` on the returned envelope — so this helper takes the token
 * as a parameter and does NOT throw on non-2xx.
 */
function renderRestKitFetchHelper(spec: ConnectorSpec): string {
  const fh = spec.fetchHelper;
  const base = resolveEnvRefs(fh.base);
  const extra =
    fh.inlineHeaders === undefined
      ? ""
      : Object.entries(fh.inlineHeaders)
          .map(([k, v]) => {
            const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
            const inner = /^\$\{env\.[A-Za-z0-9_]+\}$/.test(v)
              ? resolveEnvRefs(v).slice(2, -1)
              : JSON.stringify(v);
            return `      ${key}: ${inner},`;
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

export function renderFetchHelper(spec: ConnectorSpec): string {
  if (spec.style === "rest-kit") return renderRestKitFetchHelper(spec);

  const fh = spec.fetchHelper;
  const pathVar = fh.normalizeLeadingSlash ? "pathPart" : "path";
  const url = `\`${resolveEnvRefs(fh.base)}\${${pathVar}}\``;
  const opts = headerOption(spec);
  // Expanded form (matching grafana/newrelic) iff normalizeLeadingSlash asks for it or the
  // headers are an inline object literal; a bare `headers: headers()` accessor call (datadog,
  // sentry) stays inline. Biome preserves either shape as emitted — this is emitter-controlled.
  const expand = fh.normalizeLeadingSlash || fh.inlineHeaders !== undefined;

  const lines: string[] = [`async function ${fh.local}(path: string): Promise<unknown> {`];

  if (fh.normalizeLeadingSlash) {
    lines.push('  const pathPart = path.startsWith("/") ? path : `/${path}`;');
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
