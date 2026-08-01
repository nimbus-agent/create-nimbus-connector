import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  encodeBasicAuthHeader,
  mcpJsonResult as jsonResult,
} from "@nimbus-dev/sdk/connector-kit";
import { z } from "zod";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function token(): Promise<string> {
  if (cachedToken !== null && Date.now() < tokenExpiresAt) return cachedToken;
  const id = process.env["ZZWRITE_CLIENT_ID"]?.trim();
  const secret = process.env["ZZWRITE_CLIENT_SECRET"]?.trim();
  if (id === undefined || id === "" || secret === undefined || secret === "") {
    throw new Error("ZZWRITE_CLIENT_ID and ZZWRITE_CLIENT_SECRET must be set");
  }
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  body.set("scope", "items:readwrite");
  const res = await fetch("https://api.zzwrite.test/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: encodeBasicAuthHeader(id, secret),
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ZZ Write token exchange ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
    throw new Error("ZZ Write token response missing access_token");
  }
  cachedToken = parsed.access_token;
  // Renew a little early so a token cannot expire mid-flight between this check and the
  // request that uses it. The skew is halved for short-lived tokens, which would
  // otherwise be treated as already expired and re-exchanged on every call.
  const ttl =
    typeof parsed.expires_in === "number" && parsed.expires_in > 0
      ? parsed.expires_in - Math.min(60, Math.floor(parsed.expires_in / 2))
      : undefined;
  tokenExpiresAt = ttl === undefined ? Number.POSITIVE_INFINITY : Date.now() + ttl * 1000;
  return cachedToken;
}

async function authHeaders(): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await token()}`, Accept: "application/json" };
}

async function zzwriteGet(path: string): Promise<unknown> {
  const res = await fetch(`https://api.zzwrite.test${path}`, { headers: await authHeaders() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ZZ Write ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

async function zzwriteGetSend(
  path: string,
  method: string,
  body: string | undefined,
): Promise<unknown> {
  const res = await fetch(`https://api.zzwrite.test${path}`, {
    method,
    headers: { ...(await authHeaders()), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ZZ Write ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const mcp = new McpServer({ name: "nimbus-zzwrite", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg("zzwrite_item_list", "List items.", z.object({}), async () =>
  jsonResult(await zzwriteGet("/v1/items")),
);

reg(
  "zzwrite_item_create",
  "Create an item.",
  z.object({
    title: z.string().min(1),
    scope: z.string().optional(),
    draft: z.boolean().optional(),
  }),
  async (p) => {
    const scope = p.scope ?? "all";
    return jsonResult(
      await zzwriteGetSend(
        `/v1/items?scope=${scope}`,
        "POST",
        JSON.stringify({ title: p.title, scope, draft: p.draft }),
      ),
    );
  },
);

reg(
  "zzwrite_item_delete",
  "Delete an item by id.",
  z.object({ itemId: z.string().min(1) }),
  async (p) =>
    jsonResult(
      await zzwriteGetSend(`/v1/items/${encodeURIComponent(p.itemId)}`, "DELETE", undefined),
    ),
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
