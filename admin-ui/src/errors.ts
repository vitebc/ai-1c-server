// Перевод сырых ошибок API в понятный русский текст.
// Бэкенд отдаёт {"error": "<english>"}, request() вытаскивает поле error,
// а эта функция превращает его в человекочитаемое сообщение.

const EXACT: Record<string, string> = {
  'forbidden: insufficient permissions':
    'Недостаточно прав — это действие недоступно для вашей роли',
  'unauthorized: login or valid Bearer token required':
    'Нужен вход — сессия истекла или токен недействителен',
  'Unauthorized: invalid or missing API token':
    'Недействительный токен — войдите снова',
  'Unauthorized: session expired, please log in again':
    'Сессия истекла — войдите снова',
  'invalid username or password': 'Неверное имя пользователя или пароль',
  'invalid old password': 'Неверный старый пароль',
  'new password must be 6..128 chars': 'Пароль должен быть от 6 до 128 символов',
  'password must be 6..128 chars': 'Пароль должен быть от 6 до 128 символов',
  'username must be 3..32 chars: a-z 0-9 _ . -':
    'Имя пользователя: 3–32 символа (a-z, 0–9, _ . -)',
  'username already exists': 'Такое имя пользователя уже занято',
  'role must be admin|operator|viewer': 'Некорректная роль',
  'sections must be an object {section: bool}': 'Некорректный формат разделов',
  'cannot change own role or disable self':
    'Нельзя менять собственную роль или отключать себя',
  'cannot change own role, rights or disable self':
    'Нельзя менять собственную роль, права или отключать себя',
  'cannot delete yourself': 'Нельзя удалить самого себя',
  'cannot delete the last enabled admin':
    'Нельзя удалить последнего активного администратора',
  'cannot disable/demote the last enabled admin':
    'Нельзя отключить или понизить последнего активного администратора',
  'update failed': 'Не удалось сохранить изменения',
  'No JAR in release': 'В релизе нет JAR-файла',
  'admin role required': 'Требуется роль администратора',
  'Not found': 'Не найдено',
  // Профили конфигураций
  'parent_id cannot equal own id': 'Профиль не может быть родителем сам для себя',
  'parent_id must reference an existing main profile':
    'Родитель должен быть существующим основным профилем',
  'profile with extensions cannot become an extension':
    'Профиль с расширениями нельзя сделать расширением',
  // MCP-серверы / переиндексация
  'reindex is only supported for mcp-1c-search rows':
    'Переиндексация доступна только для строк mcp-1c-search',
  'no indexed roots found for this server': 'У этого сервера нет индексируемых папок',
  'Owner failed to start': 'Не удалось запустить владельца',
  'Session died during rebuild': 'Сессия оборвалась во время пересборки',
  'Timed out waiting for ready (neighbors restarted)':
    'Превышено ожидание готовности (соседи перезапущены)',
  // Agent Studio
  'invalid name': 'Некорректное имя',
  'name must match ^[a-z0-9-]+$ (max 64)':
    'Имя: только строчные a-z, цифры и дефис, до 64 символов',
  'project root has no docker-compose.yml': 'В корне проекта нет docker-compose.yml',
  'unknown action': 'Неизвестное действие',
  'value must be a single line': 'Значение должно быть одной строкой',
  'base_url must start with http:// or https://':
    'Адрес должен начинаться с http:// или https://',
  'Reindex triggered (stub)': 'Переиндексация запущена',
  'BSL LS stopped': 'BSL LS остановлен',
};

function pattern(msg: string): string | null {
  let m = msg.match(/too many attempts, retry in (\d+)s/);
  if (m) return `Слишком много попыток — повторите через ${m[1]} с`;
  m = msg.match(/MCP server '(.+)' not found/);
  if (m) return `MCP-сервер «${m[1]}» не найден`;
  m = msg.match(/unknown section "(.+)"/);
  if (m) return `Неизвестный раздел: ${m[1]}`;
  m = msg.match(/^API error: (\d+)$/);
  if (m) return `Ошибка сервера (код ${m[1]})`;
  m = msg.match(/^(agent|skill|pattern) "(.+)" already exists$/);
  if (m) {
    const kind = m[1] === 'agent' ? 'Агент' : m[1] === 'skill' ? 'Скилл' : 'Паттерн';
    return `${kind} «${m[2]}» уже существует`;
  }
  m = msg.match(/^key "(.+)" is not editable$/);
  if (m) return `Ключ «${m[1]}» недоступен для изменения`;
  if (msg.startsWith("Invalid 'args' JSON")) return 'Аргументы: некорректный JSON (нужен массив строк)';
  if (msg.startsWith("Invalid 'env' JSON")) return 'Окружение: некорректный JSON (нужен объект строк)';
  m = msg.match(/^BSL LS JAR not found: (.+)$/);
  if (m) return `JAR-файл BSL LS не найден: ${m[1]}`;
  m = msg.match(/^BSL LS exited with code (\d+)$/);
  if (m) return `BSL LS завершился с кодом ${m[1]}`;
  m = msg.match(/^BSL LS process error: (.+)$/);
  if (m) return `Ошибка процесса BSL LS: ${m[1]}`;
  m = msg.match(/^All download methods failed\. Last: (.+)$/);
  if (m) return `Все способы скачивания не сработали. Последняя ошибка: ${m[1]}`;
  m = msg.match(/^backend unreachable: (.+)$/);
  if (m) return `Бэкенд недоступен: ${m[1]}`;
  return null;
}

/** Человекочитаемый текст ошибки. Никогда не возвращает сырой JSON. */
export function errText(e: unknown, fallback = 'Что-то пошло не так'): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const msg = raw.trim();
  if (!msg) return fallback;
  // На случай если где-то проскочил необработанный JSON {"error": "..."}
  if (msg.startsWith('{')) {
    try {
      const parsed = JSON.parse(msg);
      const inner = typeof parsed?.error === 'string' ? parsed.error : '';
      if (inner) return errText(inner, fallback);
    } catch { /* не JSON — идём дальше */ }
  }
  return EXACT[msg] ?? pattern(msg) ?? msg;
}
