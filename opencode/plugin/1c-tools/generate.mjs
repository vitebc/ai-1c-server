// Генератор кастомных тулзов 1С из catalog.json.
// Запуск: node generate.mjs <catalog.json> <out-dir>
// Создаёт _shared.ts + по файлу на инструмент (имя файла = имя инструмента).

import fs from "node:fs";
import path from "node:path";

const [catalogPath, outDir] = process.argv.slice(2);
if (!catalogPath || !outDir) {
  console.error("usage: node generate.mjs <catalog.json> <out-dir>");
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const tools = Array.isArray(catalog.tools) ? catalog.tools : [];
fs.mkdirSync(outDir, { recursive: true });

// _shared.ts — общий модуль (лежит рядом с тулзами).
const sharedSrc = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), "_shared.ts"),
  "utf8"
);
fs.writeFileSync(path.join(outDir, "_shared.ts"), sharedSrc);

let count = 0;
for (const t of tools) {
  if (!t?.name) continue;
  const desc = t.description || `Инструмент 1С: ${t.name}`;
  // Экранируем кавычки в описании.
  const safeDesc = JSON.stringify(desc);
  const src = `// Инструмент 1С: ${t.name} (сгенерировано из catalog.json)
import { tool } from "@opencode-ai/plugin";
import { schemaToShape, callGateway } from "./_shared.ts";

export default tool({
  description: ${safeDesc},
  args: schemaToShape(${JSON.stringify(t.inputSchema || null)}, tool.schema),
  async execute(args, context) {
    const token = (process.env.ONEC_GATEWAY_TOKEN || "").trim();
    if (!token) return "ОШИБКА: нет токена плагина (ONEC_GATEWAY_TOKEN)";
    const gateway = (process.env.ONEC_GATEWAY_URL || "http://127.0.0.1:9020").trim();
    try {
      return await callGateway(gateway, token, context.sessionID, ${JSON.stringify(t.name)}, args, context.abort);
    } catch (e) {
      if (context.aborted || e?.name === "AbortError") return "ОТМЕНЕНО пользователем";
      return \`ОШИБКА вызова: \${String(e?.message || e)}\`;
    }
  },
});
`;
  fs.writeFileSync(path.join(outDir, `${t.name}.ts`), src);
  count++;
}

console.log(`generated ${count} tools + _shared.ts in ${outDir}`);
