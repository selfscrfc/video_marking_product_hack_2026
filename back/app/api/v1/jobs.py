import hashlib
import json
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import PlainTextResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import settings
from ...db import get_session
from ...errors import ApiError
from ...events import subscribe
from ...models import Job
from ...schemas import JobCreate
from ...serializers import job_out
from .common import get_job, get_video

router = APIRouter(tags=["jobs"])


def _params_hash(params: dict, structure_model: str, profile: str) -> str:
    blob = json.dumps({"p": params, "m": structure_model, "profile": profile},
                      sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()


@router.post("/videos/{video_id}/jobs", status_code=202)
def create_job(video_id: UUID, response: Response, body: JobCreate | None = None,
               db: Session = Depends(get_session)) -> dict:
    cfg = settings()
    body = body or JobCreate()
    v = get_video(db, video_id)

    params = body.params.model_dump()
    structure_model = body.structure_model or cfg.structure_model
    h = _params_hash(params, structure_model, body.profile)

    existing = db.execute(select(Job).where(Job.video_id == v.id, Job.params_hash == h)
                          ).scalar_one_or_none()
    if existing and not body.force:
        # Идемпотентность: тот же ролик с теми же параметрами не считается дважды.
        response.status_code = 200
        return job_out(existing)
    if existing and body.force:
        db.delete(existing)
        db.flush()

    job = Job(video_id=v.id, params=params | {"profile": body.profile},
              params_hash=h, structure_model=structure_model,
              status="queued", stage=None, progress=0.0)
    db.add(job)
    db.commit()
    response.headers["Location"] = f"/api/v1/jobs/{job.id}"
    return job_out(job)


@router.get("/jobs")
def list_jobs(video_id: UUID | None = None, status: str | None = None,
              limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
              db: Session = Depends(get_session)) -> dict:
    q = select(Job)
    if video_id:
        q = q.where(Job.video_id == video_id)
    if status:
        q = q.where(Job.status == status)
    rows = db.execute(q.order_by(Job.created_at.desc()).limit(limit).offset(offset)
                      ).scalars().all()
    return {"items": [job_out(j) for j in rows], "total": len(rows)}


@router.get("/jobs/{job_id}")
def get_one(job_id: UUID, db: Session = Depends(get_session)) -> dict:
    return job_out(get_job(db, job_id))


@router.post("/jobs/{job_id}/cancel", status_code=202)
def cancel(job_id: UUID, db: Session = Depends(get_session)) -> dict:
    """Задача в очереди снимается сразу.

    Уже уехавшую на Modal отменить нельзя: вызов досчитается, результат будет
    отброшен, а GPU-секунды всё равно спишутся и останутся в cost.
    """
    job = get_job(db, job_id)
    if job.status in ("succeeded", "failed", "cancelled"):
        raise ApiError(409, "job_not_cancellable", "Задача уже завершена",
                       f"статус {job.status}")
    job.status = "cancelled"
    job.finished_at = datetime.now(timezone.utc)
    db.commit()
    return job_out(job)


@router.get("/jobs/{job_id}/raw", response_class=PlainTextResponse)
def raw(job_id: UUID, db: Session = Depends(get_session)) -> str:
    """Сырой ответ модели. Сохраняется всегда, в том числе когда разбор упал."""
    import pathlib
    job = get_job(db, job_id)
    if not job.raw_path or not pathlib.Path(job.raw_path).exists():
        raise ApiError(404, "job_not_found", "Сырого ответа нет",
                       "Модель ещё не отвечала по этой задаче.")
    return pathlib.Path(job.raw_path).read_text(encoding="utf-8")


@router.get("/jobs/{job_id}/events")
async def events(job_id: UUID, db: Session = Depends(get_session)):
    """SSE. Контракт закрывается опросом; поток лишь убирает лестницу."""
    job = get_job(db, job_id)
    terminal = {"succeeded", "failed", "cancelled"}
    snapshot = job_out(job)

    async def gen():
        first = {"stage": snapshot["stage"], "stage_index": snapshot["stage_index"],
                 "progress": snapshot["progress"], "status": snapshot["status"]}
        yield f"event: stage\ndata: {json.dumps(first, ensure_ascii=False)}\n\n"
        if snapshot["status"] in terminal:
            done = {"annotation_id": str(snapshot["annotation_id"] or "")}
            yield f"event: done\ndata: {json.dumps(done, ensure_ascii=False)}\n\n"
            return
        async for msg in subscribe(job_id):
            payload = json.dumps(msg.get("data", {}), ensure_ascii=False)
            yield f"event: {msg.get('event','progress')}\ndata: {payload}\n\n"
            if msg.get("event") in ("done", "error"):
                return

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})
