---
name: base-search
description: Сопоставление базы с инструментом поиска по выгрузке конфигурации
tools: [get_configuration_info, search-erp__semantic_find, search-erp__search_code, search-erp__get_file_context, search-erp__find_symbol, search-erp__get_symbol_context, search-erp__list_objects, search-erp__get_object_structure, search-erp__find_references, search-erp__impact_analysis, search-erp__get_function_context, search-erp__get_module_functions, search-erp__smart_find, search-erp__find_function_in_object, search-erp__search_files, search-erp__stats, search-erp__benchmark, search-ka-market__semantic_find, search-ka-market__search_code, search-ka-market__get_file_context, search-ka-market__find_symbol, search-ka-market__get_symbol_context, search-ka-market__list_objects, search-ka-market__get_object_structure, search-ka-market__find_references, search-ka-market__impact_analysis, search-ka-market__get_function_context, search-ka-market__get_module_functions, search-ka-market__smart_find, search-ka-market__find_function_in_object, search-ka-market__search_files, search-ka-market__stats, search-ka-market__benchmark, search-ka-rs__semantic_find, search-ka-rs__search_code, search-ka-rs__get_file_context, search-ka-rs__find_symbol, search-ka-rs__get_symbol_context, search-ka-rs__list_objects, search-ka-rs__get_object_structure, search-ka-rs__find_references, search-ka-rs__impact_analysis, search-ka-rs__get_function_context, search-ka-rs__get_module_functions, search-ka-rs__smart_find, search-ka-rs__find_function_in_object, search-ka-rs__search_files, search-ka-rs__stats, search-ka-rs__benchmark, search-ka-td__semantic_find, search-ka-td__search_code, search-ka-td__get_file_context, search-ka-td__find_symbol, search-ka-td__get_symbol_context, search-ka-td__list_objects, search-ka-td__get_object_structure, search-ka-td__find_references, search-ka-td__impact_analysis, search-ka-td__get_function_context, search-ka-td__get_module_functions, search-ka-td__smart_find, search-ka-td__find_function_in_object, search-ka-td__search_files, search-ka-td__stats, search-ka-td__benchmark, search-upp__semantic_find, search-upp__search_code, search-upp__get_file_context, search-upp__find_symbol, search-upp__get_symbol_context, search-upp__list_objects, search-upp__get_object_structure, search-upp__find_references, search-upp__impact_analysis, search-upp__get_function_context, search-upp__get_module_functions, search-upp__smart_find, search-upp__find_function_in_object, search-upp__search_files, search-upp__stats, search-upp__benchmark]
---

# Сопоставление базы с инструментом поиска по выгрузке конфигурации

Используй этот скилл когда надо определить mcp поиска по выгрузкам конфигурации для определения метаданных или поиска кода

Выполни get_configuration_info получи имя базы
 - если база ca2, ca2_otchet* - используешь mcp search-ka-rs 
 - если база ca2_td, ca2_td_otchet* - используешь mcp search-ka-td 
 - если база erpupp, erpupp_otchet* - используешь mcp search-erp 
 - если база upp, upp_otchet* - используешь mcp search-upp
если базы нет из перечисленных, mcp для поиска по выгрузкам конфигурации не используешь
