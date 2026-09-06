"""Выбор провайдера инференса.

Провайдер — параметр конфигурации, а не имя в коде: ровно как у стадии
`structure`. Лимит трат Modal на расчётный период однажды остановил обработку
целиком, и продукт не должен зависеть от того, у кого сегодня кончились деньги.

`INFERENCE_PROVIDERS` — список через запятую в порядке предпочтения. Первый
рабочий отвечает; отказал — идём к следующему. Кто реально посчитал, видно в
ответе полем `provider`: по нему считается стоимость.
"""
from __future__ import annotations

import logging

from app.config import settings

from . import local_client, modal_client

log = logging.getLogger("worker.inference")

_PROVIDERS = {
    "local": local_client.annotate,
    "modal": modal_client.annotate,
}


def providers() -> list[str]:
    """Порядок из конфигурации, без неизвестных имён и повторов."""
    raw = [p.strip().lower() for p in settings().inference_providers.split(",")]
    seen, out = set(), []
    for p in raw:
        if p in _PROVIDERS and p not in seen:
            seen.add(p)
            out.append(p)
    if not out:
        raise RuntimeError(
            f"INFERENCE_PROVIDERS не содержит известных провайдеров: {raw}. "
            f"Доступны: {', '.join(_PROVIDERS)}")
    return out


def annotate(video_bytes: bytes, *, fps: float, max_new_tokens: int,
             suffix: str = ".mp4") -> dict:
    """Первый провайдер, который справился.

    К ответу добавляется `provider`, а если до него кто-то отказал — `attempts`.
    Переход на запасной провайдер молчать не должен: он означает, что основной
    лежит, и это надо видеть в задаче, а не только в логах.
    """
    attempts: list[dict] = []

    for name in providers():
        try:
            res = _PROVIDERS[name](video_bytes, fps=fps,
                                   max_new_tokens=max_new_tokens, suffix=suffix)
        except Exception as e:  # noqa: BLE001
            log.warning("провайдер %s отказал: %s", name, str(e)[:300])
            attempts.append({"provider": name,
                             "error": f"{type(e).__name__}: {str(e)[:300]}"})
            continue
        res["provider"] = name
        if attempts:
            res["attempts"] = attempts
            log.warning("инференс ушёл на запасной провайдер %s", name)
        return res

    detail = "; ".join(f'{a["provider"]}: {a["error"]}' for a in attempts)
    raise RuntimeError(f"ни один провайдер инференса не справился ({detail})")
