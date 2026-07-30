# Установка и развёртывание на VPS

## 1. Создание VPS

**Рекомендуемая конфигурация:**
- OS: Ubuntu 22.04 или 24.04
- RAM: 4-8 GB
- CPU: 2-4 ядра
- Диск: SSD от 20 GB
- Провайдеры: Timeweb, Selectel, Hetzner

## 2. Базовая настройка сервера

```bash
# Подключиться
ssh root@<vps-ip>

# Обновить пакеты
apt update && apt upgrade -y

# Установить базовые зависимости
apt install -y curl git build-essential pkg-config libssl-dev unzip

# Установить Node.js 22.x
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Установить Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# Установить tmux
apt install -y tmux
```

**Проверка:**
```bash
node --version    # >= 22
npm --version     # >= 10
rustc --version   # >= 1.80
cargo --version
```

## 3. Клонирование и сборка проекта

```bash
git clone https://github.com/vitebc/ai-1c-server.git
cd ai-1c-server

# Сборка (admin-ui + Rust)
./scripts/build-linux.sh
```

## 4. Запуск сервера

```bash
# Первый запуск — инициализация БД
./scripts/start.sh

# Проверка
curl http://localhost:9224/health
# → OK

# Статус
./scripts/status.sh
```

**Проверить извне:**
```bash
curl http://<vps-ip>:9224/health
```
Если не отвечает — открыть порт:
```bash
ufw allow 9224/tcp
# или на уровне провайдера
```

## 5. OpenCode на VPS

```bash
# Установить OpenCode
npm install -g @opencode/cli

# Создать tmux сессию для разработки
tmux new -s opencode
cd ~/project/ai-1c-server

# Запустить OpenCode
opencode

# Ctrl+B, D — отключиться (сессия остаётся)
# tmux attach -t opencode — вернуться
```

Если нужен веб-терминал (без SSH-клиента):
```bash
apt install -y docker.io
docker run -d --restart always -p 7681:7681 tsl0922/ttyd tmux new -A -s dev
# → http://<vps-ip>:7681
```

## 6. Подключение MCP skills к OpenCode

На клиенте (локальная машина) в `opencode.json`:

```json
{
  "mcpServers": {
    "ai-1c-skills": {
      "url": "http://<vps-ip>:9224/api/mcp-skills/rpc"
    }
  }
}
```

## 7. Импорт скилов

```bash
# Импорт из .opencode/skills/ (если есть локально)
curl -X POST http://localhost:9224/api/admin/skills/import \
  -H "Content-Type: application/json" \
  -d '{"dir":"/home/clawa/.opencode/skills"}'

# Или через веб-интерфейс:
# http://<vps-ip>:9224/skills → Import
```

## 8. Сессии разработки (tmux)

```bash
tmux new -s server       # Сервер ai-1c-server
tmux new -s code         # OpenCode / разработка
tmux new -s build        # Сборка

# Просмотр сессий
tmux ls

# Подключение к сессии
tmux attach -t code

# Убить сессию
tmux kill-session -t build
```

## 9. Обновление

```bash
cd ~/project/ai-1c-server

git pull
./scripts/build-linux.sh
./scripts/restart.sh
```

## 10. Полезные ссылки

| Ресурс | Адрес |
|--------|-------|
| **Admin Dashboard** | `http://<vps-ip>:9224/` |
| **Health Check** | `http://<vps-ip>:9224/health` |
| **MCP Skills API** | `http://<vps-ip>:9224/api/mcp-skills/rpc` |
| **Skills Export** | `http://<vps-ip>:9224/api/admin/skills/export` |
| **GitHub** | `https://github.com/vitebc/ai-1c-server` |

## 11. Структура проекта

```
ai-1c-server/
├── src/               # Rust бэкенд
│   ├── main.rs        # Точка входа, CLI
│   ├── api/           # Axum route handlers
│   ├── db/            # SQLite (rusqlite)
│   ├── mcp/           # MCP Gateway + BSL LS
│   └── auth/          # JWT аутентификация
├── admin-ui/          # React SPA
├── scripts/           # bash-скрипты
│   ├── start.sh       # Запуск сервера
│   ├── stop.sh        # Остановка
│   ├── restart.sh     # Перезапуск
│   ├── status.sh      # Проверка статуса
│   └── update.sh      # Обновление с GitHub
├── migrations/        # SQL миграции
├── data/              # Runtime (.gitignore)
│   ├── db.sqlite      # База данных
│   ├── skills/        # Скилы на диске
│   └── bsl-ls/        # BSL LS JAR
└── AGENTS.md          # Инструкция для OpenCode
```

## 12. Переменные окружения

| Переменная | Назначение | По умолчанию |
|-----------|-----------|-------------|
| `DATA_DIR` | Путь к runtime данным | `./data` |
| `PORT` | HTTP порт сервера | `9224` |

```bash
# Пример запуска с кастомными параметрами
DATA_DIR=/mnt/data PORT=8080 ./scripts/start.sh
```
