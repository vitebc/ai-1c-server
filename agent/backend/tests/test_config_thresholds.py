"""Пороги, зависящие от модели эмбеддингов.

Шкала косинуса у разных моделей разная: у fake-эмбеддингов (лексических)
совпадение видно с ~0.3, у Qwen3-Embedding косинус любых двух русских
текстов ~0.4-0.6. Один порог на всех моделей либо подхватывает скил на
любой запрос, либо не подхватывает никогда.

Поэтому пороги по умолчанию — по провайдеру, а явное значение в env
перекрывает их.
"""

from __future__ import annotations

from app.config import Settings


def test_default_thresholds_per_provider() -> None:
    fake = Settings(embeddings_provider="fake")
    llamacpp = Settings(embeddings_provider="llamacpp")
    # У реальной модели пороги выше: тот же 0.3 подхватывал бы скил на любой
    # запрос (косинус «просто русского текста» ~0.5).
    assert fake.skill_match_threshold_value < llamacpp.skill_match_threshold_value
    assert fake.kb_min_score_value == 0.0
    assert llamacpp.kb_min_score_value > 0.0


def test_explicit_threshold_overrides_provider_default() -> None:
    s = Settings(embeddings_provider="llamacpp", skill_match_threshold=0.9, kb_min_score=0.77)
    assert s.skill_match_threshold_value == 0.9
    assert s.kb_min_score_value == 0.77


def test_unknown_provider_keeps_conservative_defaults() -> None:
    s = Settings(embeddings_provider="tei")
    assert s.skill_match_threshold_value == 0.3
    assert s.kb_min_score_value == 0.0


def test_empty_env_value_means_unset() -> None:
    """Пустая строка в .env — «не задано», а не ошибка разбора."""
    s = Settings(embeddings_provider="llamacpp", skill_match_threshold="", kb_min_score="")
    assert s.skill_match_threshold_value == 0.65
    assert s.kb_min_score_value == 0.55
