"""Цикл воркера.

Очередь — сама таблица jobs через SELECT ... FOR UPDATE SKIP LOCKED. Строка
задачи и так лежит в Postgres, и отдельный брокер был бы вторым источником
истины про один и тот же статус. Redis остаётся каналом прогресса.
"""
from __future__ import annotations

import logging
import pathlib
import time
from datetime import datetime, timezone

import redis
from sqlalchemy import select

from app import services, storage
from app.config import settings
from app.db import SessionLocal, init_db
from app.events import publish
from app.models import Annotation, Job, Segment, Video
from app.serializers import STAGES

from . import inference, keyframe, parse
from .structure import structure

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("worker")

POLL_S = 1.0
HEARTBEAT_S = 5.0


def _now():
    return datetime.now(timezone.utc)


def _degraded(detail: str) -> dict:
    """Повод деградации в форме, годной и для интерфейса, и для отладки.

    `impact` живёт здесь, а не в UI: формулировка должна быть одна на всех
    экранах, где эту разметку показывают.
    """
    return {
        "stage": "structure",
        "code": "structure_failed",
        "title": "Действие и объект не разделены",
        "detail": detail,
        "impact": "Описание шага осталось одной строкой: объект и инструмент "
                  "пусты, уверенность не проставлена — их придётся заполнить руками.",
    }


def _stage(db, job: Job, name: str, progress: float) -> None:
    job.stage = name
    job.progress = progress
    db.commit()
    publish(job.id, "stage", {"stage": name, "stage_index": STAGES.index(name),
                              "progress": progress, "status": job.status})
    log.info("job %s: %s (%.2f)", job.id, name, progress)


def _claim(db) -> Job | None:
    """Берём одну очередную задачу так, чтобы её не взял второй воркер."""
    job = db.execute(
        select(Job).where(Job.status == "queued")
        .order_by(Job.created_at).limit(1)
        .with_for_update(skip_locked=True)
    ).scalar_one_or_none()
    if job:
        job.status = "running"
        job.started_at = _now()
    db.commit()
    return job


def process(db, job: Job) -> None:
    cfg = settings()
    video = db.get(Video, job.video_id)
    path = pathlib.Path(video.storage_path)
    params = job.params or {}
    fps = float(params.get("fps", cfg.marlin_fps))
    max_new = int(params.get("max_new_tokens", cfg.marlin_max_new_tokens))
    timings = {}

    # ── submit + infer ───────────────────────────────────────────────────────
    _stage(db, job, "submit", 0.05)
    t0 = time.time()
    _stage(db, job, "infer", 0.10)
    res = inference.annotate(path.read_bytes(), fps=fps,
                             max_new_tokens=max_new, suffix=path.suffix)
    timings["infer"] = round(time.time() - t0, 2)
    # Стоимость пишется под именем того, кто реально посчитал: при переходе на
    # запасного провайдера иначе не понять, чей это счёт. Локальный инференс
    # денег не стоит, но секунды считаем так же — они нужны для отчёта.
    provider = res.get("provider", "modal")
    entry = {"gpu": res.get("gpu"), "gpu_seconds": res.get("timings", {}).get("total")}
    if res.get("attempts"):
        entry["fallback_from"] = [a["provider"] for a in res["attempts"]]
    job.cost = dict(job.cost or {}, **{provider: entry})

    raw = storage.raw_path(job.id)
    raw.write_text(res["text"], encoding="utf-8")
    job.raw_path = str(raw)
    db.commit()

    # ── parse ────────────────────────────────────────────────────────────────
    _stage(db, job, "parse", 0.55)
    t0 = time.time()
    try:
        ann = parse.auto(res["text"], services.pathlib_stem(video.filename),
                         video.duration_s, model="marlin-2b")
    except parse.ParseError as e:
        # Провал разбора считается отдельно от провала модели: сырой ответ
        # сохранён и доступен пользователю по GET /jobs/{id}/raw.
        raise RuntimeError(f"model_parse_failed:{e}") from e
    timings["parse"] = round(time.time() - t0, 2)

    # ── structure ────────────────────────────────────────────────────────────
    _stage(db, job, "structure", 0.65)
    t0 = time.time()
    fields, cost, degraded = [], {}, []
    # Провал стадии не роняет задачу, но и молчать о нём нельзя: наружу уходит
    # разметка, где action — целое предложение модели, а object пуст. Раньше
    # это писалось в job.error при status=succeeded и было неотличимо от нормы.
    if not cfg.llm_api_key:
        degraded.append(_degraded("ключ провайдера не задан"))
    else:
        try:
            fields, cost = structure([s.action for s in ann.segments])
        except Exception as e:  # noqa: BLE001
            log.warning("structure не удалась: %s", e)
            degraded.append(_degraded(str(e)[:400]))
    timings["structure"] = round(time.time() - t0, 2)
    if cost:
        job.cost = dict(job.cost or {}, llm=cost)

    # ── postprocess ──────────────────────────────────────────────────────────
    _stage(db, job, "postprocess", 0.75)
    min_seg = float(params.get("min_segment_s", cfg.min_segment_s))
    segs = [s for s in ann.segments if s.duration >= min_seg] or ann.segments

    # ── keyframes ────────────────────────────────────────────────────────────
    _stage(db, job, "keyframes", 0.85)
    t0 = time.time()
    for s in segs:
        s.keyframe_ts = keyframe.pick(path, s.start_s, s.end_s)
    timings["keyframes"] = round(time.time() - t0, 2)

    # ── persist ──────────────────────────────────────────────────────────────
    _stage(db, job, "persist", 0.95)
    row = Annotation(video_id=video.id, job_id=job.id, version=1, fps=fps,
                     model="marlin-2b" + (f"+{job.structure_model}" if fields else ""),
                     degraded=degraded,
                     meta={"prompt_mode": params.get("prompt_mode", "caption"),
                           "how": res.get("how"), "gpu": res.get("gpu")})
    for i, s in enumerate(segs):
        f = fields[ann.segments.index(s)] if fields else {}
        row.segments.append(Segment(
            index=i, start_s=s.start_s, end_s=s.end_s,
            action=(f.get("action") or s.action),
            object=f.get("object", ""), tool=f.get("tool", ""),
            confidence=f.get("confidence"), keyframe_ts=s.keyframe_ts,
            edited_by_human=False))
    db.add(row)
    services.normalize(row.segments, video.duration_s)
    db.flush()

    job.annotation_id = row.id
    job.degraded = degraded
    job.timings = timings
    job.status = "succeeded"
    job.progress = 1.0
    job.finished_at = _now()
    db.commit()
    publish(job.id, "done", {"annotation_id": str(row.id)})
    log.info("job %s готова: %s шагов, %s", job.id, len(row.segments), timings)


def _requeue_orphans(db) -> int:
    """Возвращает в очередь задачи, застрявшие в running.

    Статус running означает «задачу забрал воркер», а не «она считается».
    Своего воркера у неё больше нет: процесс, который её забрал, умер вместе с
    перезапуском. Никто такую задачу уже не подберёт, и на экране обработки она
    крутится вечно — из ролика получается тупик.

    Modal-вызов при этом мог и уехать; переставить задачу в очередь дешевле, чем
    его дожидаться: `modal_call_id` сбрасывается, стадия начнётся с submit.
    """
    rows = db.execute(select(Job).where(Job.status == "running")).scalars().all()
    for job in rows:
        job.status = "queued"
        job.stage = None
        job.progress = 0.0
        job.started_at = None
        job.modal_call_id = None
    if rows:
        db.commit()
    return len(rows)


def main() -> None:
    init_db()
    r = redis.from_url(settings().redis_url)
    db = SessionLocal()
    try:
        n = _requeue_orphans(db)
        if n:
            log.warning("вернул в очередь %s задач, брошенных прошлым воркером", n)
    finally:
        db.close()
    log.info("воркер запущен")
    last_beat = 0.0

    while True:
        now = time.time()
        if now - last_beat > HEARTBEAT_S:
            try:
                r.set("worker:heartbeat", now, ex=60)
            except Exception:  # noqa: BLE001
                pass
            last_beat = now

        db = SessionLocal()
        try:
            job = _claim(db)
            if not job:
                db.close()
                time.sleep(POLL_S)
                continue
            try:
                process(db, job)
            except Exception as e:  # noqa: BLE001
                db.rollback()
                job = db.get(Job, job.id)
                code = "model_parse_failed" if str(e).startswith("model_parse_failed") \
                    else "inference_failed"
                job.status = "failed"
                job.finished_at = _now()
                job.error = {"code": code, "title": "Обработка не удалась",
                             "detail": str(e)[:600]}
                db.commit()
                publish(job.id, "error", job.error)
                log.exception("job %s упала", job.id)
        finally:
            db.close()


if __name__ == "__main__":
    main()
