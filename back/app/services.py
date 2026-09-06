"""Инварианты разметки, производные поля, экспорт."""
from __future__ import annotations

import csv
import functools
import io
import json

import jsonschema

from .config import settings
from .errors import ApiError
from .models import Annotation as AnnotationRow
from .models import Segment as SegmentRow


# ── инварианты ───────────────────────────────────────────────────────────────

def normalize(segments: list[SegmentRow], duration_s: float) -> None:
    """Сортирует по времени, переиндексирует, проверяет инварианты.

    Порядок и нумерацию держит сервер: правка одной границы может изменить и то
    и другое у соседей, и клиенту это считать незачем.
    """
    segments.sort(key=lambda s: (s.start_s, s.end_s))
    errors = []
    for i, s in enumerate(segments):
        if s.end_s <= s.start_s:
            errors.append({"pointer": f"/segments/{i}/end_s",
                           "message": f"конец должен быть больше начала ({s.start_s})"})
        if s.start_s < 0 or s.end_s > duration_s + 1e-6:
            errors.append({"pointer": f"/segments/{i}/start_s",
                           "message": f"шаг выходит за пределы ролика (0..{duration_s})"})
        if i and s.start_s < segments[i - 1].end_s - 1e-6:
            errors.append({
                "pointer": f"/segments/{i}/start_s",
                "message": f"должно быть не меньше {segments[i-1].end_s:.3f}"})
        if s.keyframe_ts is not None and not (s.start_s - 1e-6 <= s.keyframe_ts <= s.end_s + 1e-6):
            errors.append({"pointer": f"/segments/{i}/keyframe_ts",
                           "message": "ключевой кадр вне границ шага"})
        s.index = i
    if errors:
        overlap = any("не меньше" in e["message"] for e in errors)
        raise ApiError(422,
                       "segment_overlap" if overlap else "segment_inverted",
                       "Границы шагов не проходят проверку",
                       "Шаги должны идти по возрастанию и не пересекаться.",
                       errors)


def needs_review(s: SegmentRow) -> bool:
    """Производное поле.

    Палитра интерфейса монохромная, уверенность нельзя закодировать цветом —
    клиенту нужен готовый признак, а не порог, который каждый экран определит
    по-своему. Поэтому порог живёт на сервере.
    """
    cfg = settings()
    if s.confidence is not None and s.confidence < cfg.confidence_threshold:
        return True
    if not s.action.strip() or not s.object.strip():
        return True
    return (s.end_s - s.start_s) < cfg.min_segment_s


def stats(ann: AnnotationRow) -> dict:
    segs = ann.segments
    n = len(segs)
    return {
        "segment_count": n,
        "edited_count": sum(1 for s in segs if s.edited_by_human),
        "needs_review_count": sum(1 for s in segs if needs_review(s)),
        "mean_segment_s": round(sum(s.end_s - s.start_s for s in segs) / n, 3) if n else 0.0,
    }


# ── экспорт ──────────────────────────────────────────────────────────────────

def export_dict(ann: AnnotationRow, video) -> dict:
    """Канонический формат: без index, needs_review и идентификаторов.

    Ровно та форма, которую читает hyp0/metrics.py.
    """
    return {
        "video_id": pathlib_stem(video.filename),
        "duration_s": video.duration_s,
        "segments": [{
            "start_s": round(s.start_s, 3),
            "end_s": round(s.end_s, 3),
            "action": s.action,
            "object": s.object,
            "tool": s.tool,
            "confidence": s.confidence,
            "keyframe_ts": None if s.keyframe_ts is None else round(s.keyframe_ts, 3),
            "edited_by_human": s.edited_by_human,
        } for s in ann.segments],
        "fps": ann.fps,
        "model": ann.model,
        "meta": ann.meta or {},
    }


def pathlib_stem(name: str) -> str:
    return name.rsplit("/", 1)[-1].rsplit(".", 1)[0]


@functools.lru_cache
def _schema() -> dict:
    with open(settings().schema_path, encoding="utf-8") as f:
        return json.load(f)


def validate_export(payload: dict) -> None:
    """Проверка перед отдачей: невалидный файл не выходит наружу вообще."""
    v = jsonschema.Draft202012Validator(_schema())
    errs = sorted(v.iter_errors(payload), key=lambda e: list(e.absolute_path))
    if errs:
        raise ApiError(
            500, "export_schema_invalid", "Выгрузка не прошла проверку схемой",
            "Это ошибка сервиса, а не ввода: файл не отдан.",
            [{"pointer": "/" + "/".join(str(p) for p in e.absolute_path),
              "message": e.message} for e in errs[:20]])


CSV_COLUMNS = ["video_id", "segment_index", "start_s", "end_s", "action",
               "object", "tool", "confidence", "keyframe_ts", "edited_by_human"]


def export_csv(payload: dict) -> str:
    """Плоская проекция. RFC 4180, UTF-8 без BOM, точка, три знака."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
    w.writerow(CSV_COLUMNS)
    for i, s in enumerate(payload["segments"]):
        w.writerow([
            payload["video_id"], i,
            f"{s['start_s']:.3f}", f"{s['end_s']:.3f}",
            s.get("action", ""), s.get("object", ""), s.get("tool", ""),
            "" if s.get("confidence") is None else f"{s['confidence']:.3f}",
            "" if s.get("keyframe_ts") is None else f"{s['keyframe_ts']:.3f}",
            "true" if s.get("edited_by_human") else "false",
        ])
    return buf.getvalue()
