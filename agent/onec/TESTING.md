# Как проверяется расширение

Расширение `A1C_Инструменты` — XML-исходники + BSL, поэтому проверки идут слоями:
каждый ловит свой класс ошибок, и ни один не заменяет живой базы. Ниже — что именно
запускается, что это даёт и чего не даёт.

## 1. XML: `form-validate` и `cfe-validate`

Скилы из `cc-1c-skills` (лежат в `~/.opencode/skills/`), платформа не нужна:

```bash
cd agent/onec/ext
python3 ~/.opencode/skills/form-validate/scripts/form-validate.py \
    -FormPath "DataProcessors/a1c_ЧатOpenCodeV3/Forms/Форма/Ext/Form.xml"
python3 ~/.opencode/skills/cfe-validate/scripts/cfe-validate.py -ExtensionPath "Configuration.xml"
```

`form-validate` (13 проверок): уникальность id, ссылки `DataPath` на существующие
реквизиты, обработчики событий, типы элементов, `callType` у расширяемых форм.
`cfe-validate`: состав `Configuration.xml` / `<ChildObjects>`, UUID, свойства
расширения, соответствие файлов объектам.

Ловит: битые XML, висячие ссылки, дубли id, незарегистрированные объекты.
Не ловит: логику BSL, вёрстку страницы, поведение в рантайме.

## 2. BSL: BSL Language Server

```bash
java -jar data/bsl-ls/bsl-language-server-1.0.7.jar analyze \
    -s agent/onec/ext -o /tmp/opencode/bsl-out -r json
```

Отчёт — `/tmp/opencode/bsl-out/bsl-json.json` (`fileinfos[].diagnostics[]`).

Что значит «0 критичных» на примере V3: 155 диагностик, из них 43 с уровнем
Error — это 39 × `InvalidCharacterInFile` (длинное тире в комментариях) и
4 × `MissingCodeTryCatchEx` (в `Исключение` только комментарий). Остальное —
стиль: `MissingParameterDescription` 14, `LatinAndCyrillicSymbolInWord` 14,
`CodeOutOfRegion` 13, `Typo` 10, `MagicNumber` 9 и т. п.

Ловит: синтаксис, необъявленные переменные, часть ошибок структуры.
Не ловит: **поведение платформы**. Примеры этой сессии, которые прошли BSL LS
и упали в базе:

| Ошибка | Почему линтер молчит |
|---|---|
| «Метод объекта не обнаружен (Найти)» | метод документирован, статически валиден — падает только в рантайме |
| «Поле объекта недоступно для записи (Окно)» | присваивание законно, ограничение контекста формы |
| XDTO на `<content>` без `v8:` | это XML, BSL LS его не читает |

Вывод: BSL LS — гигиена, а не тест. «0 критичных» не означает «работает».

## 3. Страница: макет в браузере

Поле `ПанельHTML` рисует одну HTML-страницу из трёх макетов, поэтому вёрстку и JS
можно проверить без 1С — собрать тот же `index.html` и открыть в браузере:

```bash
python3 - <<'EOF'
base = 'agent/onec/ext/DataProcessors/a1c_ЧатOpenCodeV3/Templates/'
rd = lambda n: open(base + n + '/Ext/Template.txt', encoding='utf-8').read()
page = rd('КаркасСтраницы').replace('{{STYLES}}', rd('СтилиСтраницы')).replace('{{SCRIPT}}', rd('СкриптСтраницы'))
page = page.replace('{{HEADER}}', HEADER).replace('{{FEED}}', FEED).replace('{{COMPOSER}}', COMPOSER)
open('/tmp/opencode/v3/index.html', 'w', encoding='utf-8').write(page)
EOF
(cd /tmp/opencode/v3 && python3 -m http.server 8899)
```

`HEADER` / `FEED` / `COMPOSER` — заглушки, повторяющие то, что собирает BSL.
Клики по `#act:` в макете эмулируются обработчиком, который зовёт `selectOption`/`setValue`
как это сделала бы 1С. Смотреть на 1440 и 390 px.

Ловит: сломанную вёрстку, перекрытия, поведение карточки вопроса (подсветка варианта,
сохранение текста в соседнем поле), JS-ошибки.
Не ловит: `defaultView`/`parentWindow`, `DocumentComplete`, реальные `Href`,
движок HTML-поля конкретного клиента.

## 4. Платформа: локальный стенд

На этой машине есть всё для настоящей проверки: 1С `8.3.27.2325`
(`/opt/1cv8/x86_64/8.3.27.2325`: `1cv8`, `ibcmd`), лицензии в `~/.1cv8/licenses`,
`xvfb-run`, `Apache + wsap24.so`, node 22. Тестовая файловая база —
`/home/test/1c/ai_base` (КА 2, ~4 ГБ). Скилы лежат в
`/home/test/.config/ai-1c-server/skills/`; все команды запускаются под
`xvfb-run -a` (у платформы нет дисплея) и с явным `-V8Path`:

```bash
SK=/home/test/.config/ai-1c-server/skills
V8=/opt/1cv8/x86_64/8.3.27.2325
IB=/home/test/1c/ai_base
USER="Жеребятьев Виталий Викторович"   # логин с правами конфигуратора
PASS=315426
```

### 4.1 Состав расширений в базе — `db-cfe-admin list`

```bash
xvfb-run -a python3 $SK/db-cfe-admin/scripts/db-cfe-admin.py \
    -Command list -InfoBasePath $IB -UserName "$USER" -Password $PASS -V8Path $V8
```

Вывод: таблица расширений (Имя, Назначение, Активно, Безопасный режим, Защита).
Сейчас в `ai_base` два: `MCP_Сервер` и `A1C_Инструменты`, оба активны.

### 4.2 Версия расширения в базе — дамп с `-Extension`

`/DumpConfigToFiles` без флага расширений выгружает только основную конфигурацию
(в ней 0 DataProcessors) — расширение видно только с `-Extension`:

```bash
xvfb-run -a $V8/1cv8 DESIGNER /F "$IB" /N"$USER" /P$PASS \
    /DumpConfigToFiles /tmp/opencode/ext_dump -Extension "A1C_Инструменты" \
    -Mode 0 /Out /dev/null /DisableStartupDialogs
```

Версия — в `Configuration.xml` (`<Version>`) и в хардкоде
`DataProcessors/a1c_ИнструментДерево/Ext/Module.bsl` (строка `Версия = "<хеш>"`).
Сравнивается с локальным `agent/onec/ext/ExtVersion.txt`: совпало — база свежая,
нет — грузить (4.3). Хеш в шапке формы V3 — тот же, его можно сверить и глазами.

### 4.3 Загрузка расширения из XML — `db-load-xml`

```bash
xvfb-run -a python3 $SK/db-load-xml/scripts/db-load-xml.py \
    -V8Path $V8 -InfoBasePath $IB -UserName "$USER" -Password $PASS \
    -ConfigDir /home/test/project/ai-1c-server/agent/onec/ext \
    -Extension A1C_Инструменты
```

`-Extension` — загрузка в существующее расширение (обновление), без флага —
создание нового. `-UpdateDB` не нужен: данные базы не трогаются, обновляется
только конфигурация. После загрузки — повторить 4.2 и убедиться, что версия
совпала с `ExtVersion.txt`.

### 4.4 Проверки применимости и модулей — `db-cfe-admin check`

```bash
xvfb-run -a python3 $SK/db-cfe-admin/scripts/db-cfe-admin.py \
    -Command check -InfoBasePath $IB -UserName "$USER" -Password $PASS -V8Path $V8 \
    -Name A1C_Инструменты -Checks apply,modules -Context ThinClient,Server
```

- **применимость** (`/CheckCanApplyConfigurationExtensions`) — расширение можно
  применить к конфигурации базы;
- **модули** (`/CheckConfig -ThinClient -Server -Extension ...`) — синтаксическая
  проверка всех модулей расширения.

Ожидаемый результат (проверено 2026-11-01): применимость ОК, в модулях — только
`Variable is not defined (mcp_Метаданные)` в менеджерах `a1c_Инструмент*`. Это
**не ошибка**: `mcp_Метаданные` — объект ядра MCP-сервера (`MCP_Сервер`), а
проверка идёт с `-Extension A1C_Инструменты`, то есть расширение проверяется в
изоляции. Любые ДРУГИЕ ошибки (синтаксис, XDTO, висячие ссылки) — реальные и
блокируют загрузку/работу.

Ловит: XDTO/XML при загрузке, несобирающиеся модули, неприменимость расширения,
ошибки формы — то, что линтеры пропускают.
Не ловит: рантайм формы (открытие, нажатия, DOM), сеть.

## 5. Живая база: ручной прогон

Единственный уровень, который видит реальное поведение. База — `ai_base` (4.1),
открытие: **Все функции** → Обработки → `a1c_ЧатOpenCodeV3`. Минимальный чек-лист V3:

1. Открытие формы — нет ошибок, в шапке виден хеш сборки.
2. Промпт + Enter: сообщение появилось в ленте, статус «идёт ход», кнопка заблокирована.
3. Ответ дописывается, прокрутка не сбрасывается.
4. Форма из двух вопросов: выбираются оба варианта, текст в соседнем поле не сбрасывается,
   «Ответить» уходит одним ответом, в ленте одна строка с обоими ответами.
5. «Остановить» — ход прерывается, кнопка разблокирована.
6. «Очистить» — лента, вопрос и сессия очищены, новый промпт создаёт новую сессию.
7. Смена агента — сессия сбрасывается, новый ход идёт выбранным агентом.
8. Недоступный сервер — в статусе ошибка, форма остаётся работоспособной.

## Перед коммитом

Любая правка `agent/onec/ext/` требует бампа версии — иначе база молча останется
на старом коде, а `get_extension_version` соврёт:

```bash
cd agent/backend && uv run python scripts/bump_ext_version.py
```

Скрипт пишет хеш последнего коммита, тронувшего папку, в `onec/ext/ExtVersion.txt`,
в `Configuration.xml` (Version/Comment) и в `a1c_ИнструментДерево.ВерсияРасширения()`,
и добавляет файлы в индекс. Коммитится вместе с правкой.
