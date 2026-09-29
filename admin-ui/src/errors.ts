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
  'new password must be 8..128 chars': 'Пароль должен быть от 8 до 128 символов',
  'password must be 8..128 chars': 'Пароль должен быть от 8 до 128 символов',
  'username must be 3..32 chars: a-z 0-9 _ . -':
    'Имя пользователя: 3–32 символа (a-z, 0–9, _ . -)',
  'username already exists': 'Такое имя пользователя уже занято',
  'role must be admin|operator|viewer': 'Некорректная роль',
  'sections must be an object {section: bool}': 'Некорректный формат разделов',
  'cannot change own role or disable self':
    'Нельзя менять собственную роль или отключать себя',
  'cannot delete yourself': 'Нельзя удалить самого себя',
  'cannot delete the last enabled admin':
    'Нельзя удалить последнего активного администратора',
  'cannot disable/demote the last enabled admin':
    'Нельзя отключить или понизить последнего активного администратора',
  'update failed': 'Не удалось сохранить изменения',
  'No JAR in release': 'В релизе нет JAR-файла',
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
