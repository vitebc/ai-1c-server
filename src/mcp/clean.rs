//! Очистка JSON Schema перед уходом на границу «JSON → BSL / Структура 1С».
//!
//! Форма 1С читает схемы тулзов через `ПрочитатьJSON` в `Структура`, а ключи
//! с `$` (`$schema`, `$defs`, `$ref`, …) для неё недопустимы — «Недопустимое
//! имя свойства». Чистка применяется ТОЛЬКО к REST-инвентарю, который уходит
//! в 1С; MCP JSON-RPC-прокси и схемы, уходящие LLM, не трогаются — там
//! `$defs`/`$ref` легальны.
//!
//! Правила:
//! - удаляются ключи, начинающиеся с `$` (любой глубины);
//! - `title` — убирается (1С его не использует, а он раздувает JSON);
//! - при удалении `$defs`/`definitions` все ссылки `$ref: "#/$defs/X"`
//!   (или `#/$defs/X/...`) разворачиваются в сами определения;
//! - защита от циклических ссылок: если определение уже подставляется,
//!   ссылка заменяется на пустой объект.

use serde_json::Value;
use std::collections::HashSet;

const MAX_DEPTH: usize = 32;

/// Очистить один JSON Schema (объект) — вернуть его же без `$`-ключей и `title`.
pub fn clean_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => Value::Object(clean_object(
            map,
            0,
            &Ctx {
                defs: Value::Null,
                in_progress: HashSet::new(),
            },
        )),
        other => other.clone(),
    }
}

/// Контекст рекурсии: определения из ближайшего `$defs`/`definitions` и
/// множество путей к $ref, которые уже разворачиваются (защита от циклов).
struct Ctx {
    defs: Value,
    in_progress: HashSet<String>,
}

fn clean_object(
    map: &serde_json::Map<String, Value>,
    depth: usize,
    ctx: &Ctx,
) -> serde_json::Map<String, Value> {
    if depth >= MAX_DEPTH {
        return map.clone();
    }

    // Если в этом узле есть свои $defs/definitions — они ближе к $ref, чем
    // родительские. Запоминаем их как текущие определения для этого уровня.
    let local_defs = match map.get("$defs").or_else(|| map.get("definitions")) {
        Some(d) => d.clone(),
        None => ctx.defs.clone(),
    };

    let mut out = serde_json::Map::new();
    for (k, v) in map {
        // $ref: разворачиваем в определение (с защитой от циклов).
        if k == "$ref" {
            let ref_path = v.as_str().unwrap_or("").to_string();
            if ctx.in_progress.contains(&ref_path) {
                // Цикл — пропускаем.
                continue;
            }
            // Добавляем путь в in_progress и рекурсируем.
            let mut child_ctx = Ctx {
                defs: local_defs.clone(),
                in_progress: ctx.in_progress.clone(),
            };
            child_ctx.in_progress.insert(ref_path);
            if let Some(resolved) = resolve_ref(v, &local_defs, &child_ctx) {
                for (rk, rv) in resolved.as_object().cloned().unwrap_or_default() {
                    out.entry(rk).or_insert(rv);
                }
            }
            continue;
        }
        // Ключи с `$` и `title` не уходят в 1С — пропуск.
        if k.starts_with('$') || k == "title" {
            continue;
        }
        let child_ctx = Ctx {
            defs: local_defs.clone(),
            in_progress: ctx.in_progress.clone(),
        };
        match k.as_str() {
            "properties"
            | "items"
            | "additionalProperties"
            | "patternProperties"
            | "anyOf"
            | "allOf"
            | "oneOf"
            | "not"
            | "if"
            | "then"
            | "else" => {
                out.insert(k.clone(), clean_value(v, depth + 1, &child_ctx));
            }
            _ => {
                // Остальные ключи (type, description, enum, default, …).
                // Если значение — объект или массив, чистим его тоже:
                // в JSON Schema значения свойств внутри `properties` сами
                // являются схемами и могут содержать $schema/$defs.
                match v {
                    Value::Object(_) | Value::Array(_) => {
                        out.insert(k.clone(), clean_value(v, depth + 1, &child_ctx));
                    }
                    _ => {
                        out.insert(k.clone(), v.clone());
                    }
                }
            }
        }
    }
    out
}

fn clean_value(v: &Value, depth: usize, ctx: &Ctx) -> Value {
    match v {
        Value::Object(map) => Value::Object(clean_object(map, depth + 1, ctx)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|it| clean_value(it, depth + 1, ctx))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Развернуть `$ref: "#/$defs/X"` (или `#/definitions/X`) в определение.
/// Возвращает None если ссылка не резолвится.
fn resolve_ref(v: &Value, defs: &Value, ctx: &Ctx) -> Option<Value> {
    let path = v.as_str()?;
    let rest = path
        .strip_prefix("#/$defs/")
        .or_else(|| path.strip_prefix("#/definitions/"))?;

    // Идём по пути в defs.
    let mut current: &Value = defs;
    for part in rest.split('/') {
        current = current.get(part)?;
    }

    // Рекурсивно чистим определение (оно само может содержать $ref).
    Some(clean_value(current, 0, ctx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_dollar_keys_and_title() {
        let schema = json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "MyTool",
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Имя"},
                "nested": {
                    "$schema": "http://json-schema.org/draft-07/schema#",
                    "title": "Nested",
                    "type": "object",
                    "properties": {"x": {"type": "integer"}}
                }
            },
            "required": ["name"]
        });
        let cleaned = clean_schema(&schema);
        assert!(cleaned.get("$schema").is_none());
        assert!(cleaned.get("title").is_none());
        assert_eq!(cleaned["type"], "object");
        assert!(cleaned["properties"]["nested"].get("$schema").is_none());
        assert!(cleaned["properties"]["nested"].get("title").is_none());
        assert_eq!(
            cleaned["properties"]["nested"]["properties"]["x"]["type"],
            "integer"
        );
    }

    #[test]
    fn resolves_defs_refs() {
        let schema = json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "addr": {"$ref": "#/$defs/Address"},
                "plain": {"type": "string"}
            },
            "$defs": {
                "Address": {
                    "type": "object",
                    "properties": {
                        "city": {"type": "string"}
                    }
                }
            }
        });
        let cleaned = clean_schema(&schema);
        assert!(cleaned.get("$defs").is_none());
        // $ref развёрнут в определение.
        assert_eq!(cleaned["properties"]["addr"]["type"], "object");
        assert_eq!(
            cleaned["properties"]["addr"]["properties"]["city"]["type"],
            "string"
        );
    }

    #[test]
    fn handles_cyclic_refs() {
        let schema = json!({
            "$defs": {
                "Node": {
                    "type": "object",
                    "properties": {
                        "next": {"$ref": "#/$defs/Node"}
                    }
                }
            },
            "$ref": "#/$defs/Node"
        });
        let cleaned = clean_schema(&schema);
        // Цикл: вложенный $ref заменён на пустой объект, без бесконечной рекурсии.
        assert_eq!(cleaned["type"], "object");
        assert!(cleaned["properties"]["next"].is_object());
    }

    #[test]
    fn non_object_passthrough() {
        let v = json!("just a string");
        assert_eq!(clean_schema(&v), v);
    }
}
