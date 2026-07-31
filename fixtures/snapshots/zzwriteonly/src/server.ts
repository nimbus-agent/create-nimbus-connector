import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "@nimbus-dev/sdk/connector-kit";
import { z } from "zod";

function headers(): Record<string, string> {
  const t = process.env["ZZWRITEONLY_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("ZZWRITEONLY_TOKEN is not set");
  }
  return { Authorization: `Bearer ${t}`, Accept: "application/json" };
}

async function zzGetSend(path: string, method: string, body: string | undefined): Promise<unknown> {
  const res = await fetch(`https://api.zzwriteonly.test${path}`, {
    method,
    headers: { ...headers(), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ZZ Write Only ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const mcp = new McpServer({ name: "nimbus-zzwriteonly", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "zzwriteonly_item_create",
  "Create an item.",
  z.object({ title: z.string().min(1), draft: z.boolean().optional() }),
  async (p) =>
    jsonResult(
      await zzGetSend("/v1/items", "POST", JSON.stringify({ title: p.title, draft: p.draft })),
    ),
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
