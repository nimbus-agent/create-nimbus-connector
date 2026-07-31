import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  makeRestToolRegistrar,
} from "@nimbus-dev/sdk/connector-kit";
import { z } from "zod";

async function zzwriteRestFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const url = path.startsWith("http") ? path : `https://api.zzwriterest.test${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

const server = new McpServer({ name: "nimbus-zzwriterest", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

const registerZzwriterestTool = makeRestToolRegistrar({
  registrar: reg,
  tokenEnv: "ZZWRITEREST_TOKEN",
  serviceLabel: "ZZ Write Rest",
  fetch: zzwriteRestFetch,
});

registerZzwriterestTool("zzwriterest_item_list", "List items.", z.object({}), () => "/v1/items");

registerZzwriterestTool(
  "zzwriterest_item_update",
  "Update an item's title.",
  z.object({
    itemId: z.string().min(1),
    title: z.string().min(1),
    mode: z.string().optional(),
    notify: z.boolean().optional(),
  }),
  (parsed) => {
    const mode = parsed.mode ?? "merge";
    return `/v1/items/${encodeURIComponent(parsed.itemId)}?mode=${mode}`;
  },
  (parsed) => ({
    method: "PATCH",
    body: JSON.stringify({
      title: parsed.title,
      mode: parsed.mode ?? "merge",
      notify: parsed.notify,
    }),
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
