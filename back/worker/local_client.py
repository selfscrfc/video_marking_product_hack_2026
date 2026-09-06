"""Вызов Marlin-2B, запущенного на хосте.

Docker на macOS не пробрасывает MPS, поэтому модель живёт вне контейнера, а
воркер ходит в неё по HTTP — ровно так же, как ходил бы к внешнему провайдеру.
Адрес по умолчанию — host.docker.internal, это хост со стороны контейнера.

Ролик уходит сырыми байтами: сеть здесь локальная, раздувать десять мегабайт
в base64 незачем.
"""
from __future__ import annotations

import httpx

from app.config import settings

# Ролик считается 26–29 с на M4 Pro, но первый запрос может застать модель на
# загрузке. Потолок берём от бюджета кейса, а не от медианы.
_HTTP_TIMEOUT_S = 300.0


def annotate(video_bytes: bytes, *, fps: float, max_new_tokens: int,
             suffix: str = ".mp4") -> dict:
    cfg = settings()
    if not cfg.local_inference_url:
        raise RuntimeError("локальный инференс не настроен: нужен LOCAL_INFERENCE_URL")

    r = httpx.post(
        f"{cfg.local_inference_url.rstrip('/')}/annotate",
        params={"fps": fps, "max_new_tokens": max_new_tokens, "suffix": suffix},
        content=video_bytes,
        headers={"Content-Type": "application/octet-stream"},
        timeout=_HTTP_TIMEOUT_S,
    )
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, dict) or "text" not in data:
        raise RuntimeError(f"локальный сервис вернул ответ без text: {str(data)[:300]}")
    return data
