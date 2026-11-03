// Общий модуль для кастомных тулзов 1С (config/<server>/tools/*.ts).
// Каждый тулз — отдельный файл: имя файла = имя инструмента.
// Вызовы идут через шлюз ai-1c-server: POST {gateway}/onec/rpc с
// X-OpenCode-Token + sessionID; шлюз подставляет JWT пользователя 1С из
// реестра сессий (per-user RLS).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    return JSON.parse(
      fs.readFileSync(path.join(here, "catalog.json"), "utf8")
    );
  } catch {
    return null;
  }
}

// JSON Schema → zod shape (tool.schema — это zod).
export function schemaToShape(
  schema: JsonSchema | undefined,
  z: any
): Record<string, any> {
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
    const required =
      Array.isArray(schema.required) && schema.required.includes(key);
    out[key] = required ? field : field.optional();
  }
  return out;
}

export function toolDescription(name: string): string {
  const catalog = loadCatalog();
  const t = catalog?.tools?.find((x) => x.name === name);
  return t?.description || `Инструмент 1С: ${name}`;
}

export async function callGateway(
  gateway: string,
  token: string,
  sessionID: string,
  name: string,
  args: Record<string, any>,
  signal?: AbortSignal
): Promise<string> {
  const url = gateway.replace(/\/+$/, "") + "/onec/rpc";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-OpenCode-Token": token,
    },
    body: JSON.stringify({
      session_id: sessionID,
      params: { name, arguments: args },
    }),
    signal,
  });
  const text = await res.text();
  if (!res.ok)
    return `ОШИБКА шлюза ${res.status}: ${text.slice(0, 2000)}`;
  let env: any;
  try {
    env = JSON.parse(text);
  } catch {
    return text.slice(0, 20000);
  }
  if (env.error) {
    const msg =
      typeof env.error === "string" ? env.error : JSON.stringify(env.error);
    return `ОШИБКА 1С: ${msg.slice(0, 4000)}`;
  }
  const result = env.result;
  if (result == null) return "(пустой результат)";
  if (typeof result === "object" && Array.isArray(result.content)) {
    const parts = result.content
      .map((c: any) =>
        typeof c.text === "string" ? c.text : JSON.stringify(c)
      )
      .join("\n");
    const out = parts.slice(0, 50000);
    return result.isError ? `ОШИБКА 1С: ${out}` : out;
  }
  return JSON.stringify(result).slice(0, 50000);
}
