ARG UV_IMAGE=ghcr.io/astral-sh/uv:latest
FROM ${UV_IMAGE} AS uvstage

FROM python:3.12-slim
COPY --from=uvstage /uv /bin/uv

WORKDIR /app
ENV UV_SYSTEM_PYTHON=1 \
    PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev

COPY src ./src
COPY alembic ./alembic
COPY alembic.ini ./
COPY skills ./skills
COPY agents ./agents
COPY patterns ./patterns
# Скрипты запуска из контейнера: scripts/ingest_kb.py (инжест базы знаний),
# scripts/smoke_tools.py (смоук function calling).
COPY scripts ./scripts

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "src"]
