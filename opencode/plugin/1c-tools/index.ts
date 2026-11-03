// Плагин OpenCode 1c-tools: инструменты 1С (execute_select, validate_query и др.)
// как кастомные тулзы. Каталог — catalog.json рядом с плагином (собирается
// кнопкой «Синхронизировать» в админке). Вызовы идут через шлюз ai-1c-server:
// POST {gateway}/onec/rpc с X-OpenCode-Token + sessionID; шлюз подставляет JWT
// пользователя 1С из реестра сессий (per-user RLS).
//
// Плагин v2 API: export const OneCToolsPlugin = { id, server }, где server —
// async fn (input, options) → Hooks { tool: { [name]: tool({...}) } }.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tool, type ToolContext } from "@opencode-ai/plugin";

type JsonSchema = {
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
  description?: string;
};

type CatalogTool = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
};

type Catalog = {
  gateway_token?: string;
  tools?: CatalogTool[];
};

const here = path.dirname(fileURLToPath(import.meta.url));

function loadCatalog(): Catalog | null {
  try {
    const raw = fs.readFileSync(path.join(here, "catalog.json"), "utf8");
    return JSON.parse(raw) as Catalog;
  } catch {
    return null;
  }
}

// JSON Schema → zod shape (zod 4 доступен в рантайме OpenCode).
function schemaToShape(schema: JsonSchema | undefined, z: any): Record<string, any> {
  if (!schema || !schema.properties) return {};
  const out: Record<string, any> = {};
  for (const [key, prop] of Object.entries<any>(schema.properties)) {
    let field: any;
    switch (prop.type) {
      case "number":
        field = z.number();
        break;
      case "integer":
        field = z.number().int();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "array":
        field = z.array(z.any());
        break;
      default:
        field = z.string();
    }
    if (prop.description) field = field.describe(prop.description);
    const required = Array.isArray(schema.required) && schema.required.includes(key);
    out[key] = required ? field : field.optional();
  }
  return out;
}

async function callGateway(
  gateway: string,
  token: string,
  sessionID: string,
  name: string,
  args: Record<string, any>,
  signal: AbortSignal,
): Promise<string> {
  const url = gateway.replace(/\/+$/, "") + "/onec/rpc";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-OpenCode-Token": token,
    },
    body: JSON.stringify({ session_id: sessionID, params: { name, arguments: args } }),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    return `ОШИБКА шлюза ${res.status}: ${text.slice(0, 2000)}`;
  }
  // Ответ — JSON-RPC envelope: {jsonrpc, id, result | error}.
  let env: any;
  try {
    env = JSON.parse(text);
  } catch {
    return text.slice(0, 20000);
  }
  if (env.error) {
    const msg = typeof env.error === "string" ? env.error : JSON.stringify(env.error);
    return `ОШИБКА 1С: ${msg.slice(0, 4000)}`;
  }
  const result = env.result;
  if (result == null) return "(пустой результат)";
  // MCP tools/call: {content: [{type:"text", text}], isError?}
  if (typeof result === "object" && Array.isArray(result.content)) {
    const parts = result.content
      .map((c: any) => (typeof c.text === "string" ? c.text : JSON.stringify(c)))
      .join("\n");
    const out = parts.slice(0, 50000);
    return result.isError ? `ОШИБКА 1С: ${out}` : out;
  }
  return JSON.stringify(result).slice(0, 50000);
}

async function pluginServer(_input: any, _options?: any): Promise<any> {
  const catalog = loadCatalog();
  if (!catalog || !Array.isArray(catalog.tools)) {
    // Каталог не собран — плагин молча не регистрирует инструментов.
    return {};
  }
  const gateway = (process.env.ONEC_GATEWAY_URL || "http://127.0.0.1:9020").trim();
  const token = catalog.gateway_token || process.env.ONEC_GATEWAY_TOKEN || "";

  const tools: Record<string, any> = {};
  for (const t of catalog.tools) {
    if (!t?.name) continue;
    const shape = schemaToShape(t.inputSchema, tool.schema);
    tools[t.name] = tool({
      description: t.description || `Инструмент 1С: ${t.name}`,
      args: shape,
      async execute(args: Record<string, any>, context: ToolContext) {
        if (!token) {
          return "ОШИБКА: нет токена плагина (gateway_token в catalog.json)";
        }
        try {
          return await callGateway(gateway, token, context.sessionID, t.name, args, context.abort);
        } catch (e: any) {
          if (context.aborted || e?.name === "AbortError") {
            return "ОТМЕНЕНО пользователем";
          }
          return `ОШИБКА вызова: ${String(e?.message || e)}`;
        }
      },
    });
  }
  return { tool: tools };
}

export default { id: "1c-tools", effect: pluginServer };
