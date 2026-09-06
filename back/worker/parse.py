"""Разбор ответов моделей в Annotation.

Копия hyp0/parse.py — hyp0 лежит вне этого репозитория и вне контекста
сборки образа, поэтому держится копией, а не импортом. Правки обязаны
ехать в обе стороны: разойдутся — метрика начнёт мерить не то.

Три формата, потому что модели отвечают по-разному:
  json      — то, что просит наш промпт (Qwen3-VL, Mage-VL, любая с guided JSON);
  marlin    — родной формат Marlin-2B: строки «<X.X - Y.Y> описание»;
  fallback  — свободный текст с таймкодами, на случай когда модель проигнорировала схему.

Парсер обязан быть терпимым: провал разбора нельзя записывать в провал модели,
его надо видеть отдельно. Поэтому все функции бросают ParseError, а раннер
считает такие ролики в отдельную графу.
"""
from __future__ import annotations

import json
import re

from app.domain import Annotation, Segment


class ParseError(Exception):
    pass


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)
# «<12.5 - 18.0> ставит кружку» и «12.5 - 18.0: ставит кружку»
_MARLIN = re.compile(
    r"^\s*<?\s*(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*>?\s*[:.]?\s*(.+?)\s*$")


def _clip(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _finish(video_id: str, duration_s: float, segs: list[Segment],
            model: str, raw: str) -> Annotation:
    if not segs:
        raise ParseError("не найдено ни одного шага")
    segs.sort(key=lambda s: s.start_s)
    return Annotation(video_id=video_id, duration_s=duration_s, segments=segs,
                      model=model, meta={"raw_len": len(raw)})


def from_json(text: str, video_id: str, duration_s: float, model: str = "") -> Annotation:
    """Разбирает ответ по нашей схеме. Терпит ```-обёртку и мусор вокруг."""
    body = text.strip()
    m = _FENCE.search(body)
    if m:
        body = m.group(1).strip()
    if not body.startswith(("{", "[")):
        # Модель могла обернуть ответ прозой. Берём самый внешний объект или
        # массив — что встретилось раньше: ответ бывает и голым списком шагов.
        cands = [(body.find(o), body.rfind(c)) for o, c in (("{", "}"), ("[", "]"))]
        cands = [(i, j) for i, j in cands if i != -1 and j > i]
        if not cands:
            raise ParseError("в ответе нет JSON-объекта или массива")
        i, j = min(cands)
        body = body[i:j + 1]
    try:
        data = json.loads(body)
    except json.JSONDecodeError as e:
        raise ParseError(f"невалидный JSON: {e}") from e

    if isinstance(data, list):
        steps = data                      # модель вернула голый список шагов
    elif isinstance(data, dict):
        steps = data.get("steps")
    else:
        steps = None
    if not isinstance(steps, list):
        raise ParseError("нет поля steps со списком")

    segs: list[Segment] = []
    for s in steps:
        if not isinstance(s, dict) or "start_s" not in s or "end_s" not in s:
            continue
        try:
            a = _clip(float(s["start_s"]), 0.0, duration_s)
            b = _clip(float(s["end_s"]), 0.0, duration_s)
        except (TypeError, ValueError):
            continue
        if b <= a:
            continue  # вырожденный шаг — модель иногда выдаёт нулевую длину
        conf = s.get("confidence")
        segs.append(Segment(
            start_s=a, end_s=b,
            action=str(s.get("action", "") or "").strip(),
            object=str(s.get("object", "") or "").strip(),
            tool=str(s.get("tool", "") or "").strip(),
            confidence=float(conf) if isinstance(conf, (int, float)) else None,
        ))
    return _finish(video_id, duration_s, segs, model, text)


def from_marlin(text: str, video_id: str, duration_s: float, model: str = "") -> Annotation:
    """Родной caption-режим Marlin: Scene-абзац + строки «<X.X - Y.Y> описание».

    Описание кладём целиком в action: Marlin не разделяет глагол и объект, а
    насильно резать строку по первому пробелу — значит портить данные. Разделение
    делает судья при сверке.
    """
    segs: list[Segment] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.lower().startswith("scene:"):
            continue
        m = _MARLIN.match(line)
        if not m:
            continue
        a, b, desc = float(m.group(1)), float(m.group(2)), m.group(3).strip()
        a, b = _clip(a, 0.0, duration_s), _clip(b, 0.0, duration_s)
        if b <= a:
            continue
        segs.append(Segment(start_s=a, end_s=b, action=desc))
    return _finish(video_id, duration_s, segs, model, text)


def auto(text: str, video_id: str, duration_s: float, model: str = "") -> Annotation:
    """Пробует json, потом marlin. Для прогонов, где формат заранее не зафиксирован."""
    try:
        return from_json(text, video_id, duration_s, model)
    except ParseError:
        return from_marlin(text, video_id, duration_s, model)


def fill_descriptions(base: Annotation, text: str) -> Annotation:
    """Режим 0b: границы из base, описания из ответа модели по index."""
    body = text.strip()
    m = _FENCE.search(body)
    if m:
        body = m.group(1).strip()
    i, j = body.find("{"), body.rfind("}")
    if i == -1 or j <= i:
        raise ParseError("в ответе нет JSON-объекта")
    try:
        steps = json.loads(body[i:j + 1]).get("steps", [])
    except json.JSONDecodeError as e:
        raise ParseError(f"невалидный JSON: {e}") from e

    by_idx = {int(s["index"]): s for s in steps
              if isinstance(s, dict) and isinstance(s.get("index"), (int, float))}
    segs: list[Segment] = []
    for k, s in enumerate(sorted(base.segments, key=lambda x: x.start_s)):
        d = by_idx.get(k, {})
        conf = d.get("confidence")
        segs.append(Segment(
            start_s=s.start_s, end_s=s.end_s,
            action=str(d.get("action", "") or "").strip(),
            object=str(d.get("object", "") or "").strip(),
            tool=str(d.get("tool", "") or "").strip(),
            confidence=float(conf) if isinstance(conf, (int, float)) else None,
        ))
    return Annotation(video_id=base.video_id, duration_s=base.duration_s,
                      segments=segs, model=base.model, meta={"mode": "0b"})
