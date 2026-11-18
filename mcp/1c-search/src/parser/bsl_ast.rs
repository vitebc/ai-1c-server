use tree_sitter::Parser;

pub fn create_bsl_parser() -> Parser {
    let mut parser = Parser::new();
    let language: tree_sitter::Language = tree_sitter_bsl::LANGUAGE.into();
    parser.set_language(&language).expect("Error loading BSL grammar");
    parser
}

#[derive(Debug, Clone)]
pub struct BslSymbol {
    pub name: String,
    pub kind: String,    // "procedure" | "function"
    pub start_line: u32, // 1-based
    pub end_line: u32,   // 1-based
    pub is_export: bool,
    pub calls: Vec<String>, // names of called functions/procedures
}

/// BSL keywords that appear as identifiers in calls but are not function names.
const BSL_KEYWORDS: &[&str] = &[
    "если", "иначеесли", "иначе", "конецесли",
    "пока", "конецпока", "для", "каждого", "из", "по", "конеццикла", "конецдля",
    "попытка", "исключение", "вызватьисключение", "конецпопытки",
    "возврат", "прервать", "продолжить",
    "перейти",
    "новый",
    "истина", "ложь", "неопределено", "null",
    "и", "или", "не",
    "экспорт",
    "перем",
    // English aliases
    "if", "elseif", "else", "endif",
    "while", "endwhile", "for", "each", "in", "to", "endfor",
    "try", "except", "raise", "endtry",
    "return", "break", "continue",
    "goto",
    "new",
    "true", "false", "undefined",
    "and", "or", "not",
    "export",
    "var",
];

/// Collect all `method_call` node names within a subtree (excluding nested function/proc bodies).
fn extract_calls_from_node(node: tree_sitter::Node, source: &[u8], seen: &mut std::collections::HashSet<String>, result: &mut Vec<String>) {
    let kind = node.kind();

    // Do not descend into nested function/procedure definitions
    if kind == "procedure_definition" || kind == "function_definition" {
        return;
    }

    // method_call has a `name` field with the function name identifier
    if kind == "method_call" {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = name_node.utf8_text(source).unwrap_or("").trim().to_string();
            if !name.is_empty() {
                let name_lower = name.to_lowercase();
                if !BSL_KEYWORDS.contains(&name_lower.as_str()) && !seen.contains(&name_lower) {
                    seen.insert(name_lower);
                    result.push(name);
                }
            }
        }
    }

    let child_count = node.child_count();
    for i in 0..child_count {
        if let Some(child) = node.child(i) {
            extract_calls_from_node(child, source, seen, result);
        }
    }
}

/// Похож ли текст на двоичный мусор.
///
/// Признаки: NUL или управляющие символы (кроме \t \r \n) либо заметная доля
/// символов замены U+FFFD. Нормальный BSL-модуль (UTF-8 или корректно
/// раскодированный cp1251) таких байтов не содержит.
fn looks_binary(source: &str) -> bool {
    if source.is_empty() {
        return false;
    }
    let mut control = 0usize;
    let mut replacement = 0usize;
    for ch in source.chars() {
        if ch == '\u{FFFD}' {
            replacement += 1;
        } else if ch != '\n' && ch != '\r' && ch != '\t' && (ch as u32) < 0x20 {
            control += 1;
            if control > 2 {
                return true;
            }
        }
    }
    replacement * 50 > source.chars().count()
}

/// Extract all procedure and function definitions from BSL source code.
pub fn extract_symbols(source: &str) -> Vec<BslSymbol> {
    // Бинарные/повреждённые модули: в выгрузках KA2 встречаются .bsl не в
    // UTF-8 и не в cp1251 — высокоэнтропийный мусор с NUL и управляющими
    // байтами. На таком «исходнике» внешний сканер tree-sitter-bsl уходит в
    // бесконечный цикл (progress-callback при этом не вызывается), поэтому
    // такие файлы индексируются без символов, но не блокируют сборку.
    if looks_binary(source) {
        return vec![];
    }

    // NUL-байты в остальном тексте всё равно вычищаем (дешёвая страховка).
    let sanitized: String;
    let source = if source.as_bytes().contains(&0) {
        sanitized = source.replace('\0', " ");
        sanitized.as_str()
    } else {
        source
    };
    let mut parser = create_bsl_parser();
    let bytes = source.as_bytes();
    // Предохранитель от бесконечного парсинга: progress-callback получает
    // управление по ходу разбора и отменяет его по дедлайну. Некоторые
    // win1251-модули (KA2/Documents/Увольнение) вешали парсер навсегда.
    //
    // ВАЖНО: в tree-sitter callback ОТМЕНЯЕТ разбор, когда возвращает true
    // (см. ts_parser__check_progress: `... && progress_callback(...)`).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let mut input = |offset: usize, _point: tree_sitter::Point| -> &[u8] {
        if offset >= bytes.len() { &[] } else { &bytes[offset..] }
    };
    let mut progress = |_state: &tree_sitter::ParseState| std::time::Instant::now() > deadline;
    let options = tree_sitter::ParseOptions::new().progress_callback(&mut progress);
    let tree = match parser.parse_with_options(&mut input, None, Some(options)) {
        Some(t) => t,
        None => {
            eprintln!(
                "[1c-search] Парсинг прерван по таймауту ({} КБ) — файл индексируется без символов",
                bytes.len() / 1024
            );
            return vec![];
        }
    };
    let root = tree.root_node();
    let source_bytes = source.as_bytes();
    let mut symbols = Vec::new();
    traverse_for_symbols(root, source_bytes, &mut symbols);
    symbols
}

fn traverse_for_symbols(node: tree_sitter::Node, source: &[u8], symbols: &mut Vec<BslSymbol>) {
    let kind = node.kind();
    if kind == "procedure_definition" || kind == "function_definition" {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = name_node.utf8_text(source).unwrap_or("").to_string();
            if !name.is_empty() {
                let is_export = node.child_by_field_name("export").is_some();
                let start_line = node.start_position().row as u32 + 1;
                let end_line = node.end_position().row as u32 + 1;
                let sym_kind = if kind == "procedure_definition" { "procedure" } else { "function" };

                // Extract calls from function body
                let mut seen = std::collections::HashSet::new();
                let mut calls = Vec::new();
                let child_count = node.child_count();
                for i in 0..child_count {
                    if let Some(child) = node.child(i) {
                        let child_kind = child.kind();
                        // Skip the signature parts: name, parameters, export keyword
                        if child_kind != "identifier" && child_kind != "parameters" && !child_kind.contains("keyword") {
                            extract_calls_from_node(child, source, &mut seen, &mut calls);
                        }
                    }
                }

                symbols.push(BslSymbol {
                    name,
                    kind: sym_kind.to_string(),
                    start_line,
                    end_line,
                    is_export,
                    calls,
                });
            }
        }
        // Don't traverse into procedure/function body for nested defs
        return;
    }

    let child_count = node.child_count();
    for i in 0..child_count {
        if let Some(child) = node.child(i) {
            traverse_for_symbols(child, source, symbols);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bsl_parser_initialization() {
        let mut parser = create_bsl_parser();
        let code = "Процедура Тест() КонецПроцедуры";
        let tree = parser.parse(code, None).unwrap();
        assert_eq!(tree.root_node().kind(), "source_file");
    }

    #[test]
    fn test_extract_symbols() {
        let code = "Процедура МояПроцедура() Экспорт\nКонецПроцедуры\n\nФункция МояФункция(Параметр)\n\tВозврат Параметр;\nКонецФункции\n";
        let symbols = extract_symbols(code);
        assert_eq!(symbols.len(), 2);
        assert_eq!(symbols[0].name, "МояПроцедура");
        assert_eq!(symbols[0].kind, "procedure");
        assert!(symbols[0].is_export);
        assert_eq!(symbols[1].name, "МояФункция");
        assert_eq!(symbols[1].kind, "function");
        assert!(!symbols[1].is_export);
    }

    #[test]
    fn test_extract_calls() {
        let code = "Процедура МояПроцедура()\n\tПодготовитьДанные();\n\tЗаписатьВЖурнал(\"текст\");\n\tОбъект.МойМетод();\nКонецПроцедуры\n";
        let symbols = extract_symbols(code);
        assert_eq!(symbols.len(), 1);
        let calls = &symbols[0].calls;
        assert!(calls.contains(&"ПодготовитьДанные".to_string()));
        assert!(calls.contains(&"ЗаписатьВЖурнал".to_string()));
        assert!(calls.contains(&"МойМетод".to_string()));
    }
}
