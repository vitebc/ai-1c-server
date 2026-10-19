---
name: base-search
description: Сопоставление базы с инструментом поиска по выгрузке конфигурации
tools: [get_configuration_info]
---

# Сопоставление базы с инструментом поиска по выгрузке конфигурации

Используй этот скилл когда надо определить mcp поиска по выгрузкам конфигурации для определения метаданных или поиска кода

Выполни get_configuration_info получи имя базы
 - если база ca2, ca2_otchet* - используешь mcp search-ka-rs 
 - если база ca2_td, ca2_td_otchet* - используешь mcp search-ka-td 
 - если база erpupp, erpupp_otchet* - используешь mcp search-erp 
 - если база upp, upp_otchet* - используешь mcp search-upp
