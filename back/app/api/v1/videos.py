import hashlib
import os
import pathlib
import re
from uuid import UUID

from fastapi import APIRouter, Depends, File, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import media, storage
from ...config import settings
from ...db import get_session
from ...errors import ApiError
from ...models import Video
from .common import get_video, latest_annotation

router = APIRouter(tags=["videos"])

ACCEPTED = {"video/mp4": ".mp4", "video/quicktime": ".mov"}


def _out(db: Session, v: Video) -> dict:
    from ...models import Job
    ann = latest_annotation(db, v.id)
    job = db.execute(select(Job).where(Job.video_id == v.id)
                     .order_by(Job.created_at.desc()).limit(1)).scalar_one_or_none()
    return {
        "video_id": v.id, "filename": v.filename, "mime": v.mime,
        "duration_s": v.duration_s, "fps": v.fps, "width": v.width, "height": v.height,
        "size_bytes": v.size_bytes, "sha256": v.sha256, "created_at": v.created_at,
        "latest_annotation_id": ann.id if ann else None,
        "latest_job_id": job.id if job else None,
    }


@router.get("/videos")
def list_videos(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                db: Session = Depends(get_session)) -> dict:
    total = db.execute(select(Video)).scalars().all()
    rows = db.execute(select(Video).order_by(Video.created_at.desc())
                      .limit(limit).offset(offset)).scalars().all()
    return {"items": [_out(db, v) for v in rows], "total": len(total)}


@router.post("/videos", status_code=201)
def upload_video(response: Response, file: UploadFile = File(...),
                 db: Session = Depends(get_session)) -> dict:
    cfg = settings()
    data = file.file.read()
    if len(data) > cfg.max_upload_bytes:
        raise ApiError(413, "video_too_large", "Файл слишком большой",
                       f"{len(data)} байт при лимите {cfg.max_upload_bytes}")

    suffix = pathlib.Path(file.filename or "video.mp4").suffix.lower()
    mime = file.content_type or ""
    if mime not in ACCEPTED and suffix not in ACCEPTED.values():
        raise ApiError(415, "video_format_unsupported", "Формат не поддерживается",
                       f"принимаем MP4 и MOV, получили {mime or suffix!r}")
    suffix = suffix if suffix in ACCEPTED.values() else ACCEPTED.get(mime, ".mp4")
    # Клиент может не прислать тип (curl шлёт application/octet-stream). Храним
    # тип, выведенный из расширения: он же поедет в Content-Type для <video>.
    mime = next(m for m, ext in ACCEPTED.items() if ext == suffix)

    digest = hashlib.sha256(data).hexdigest()
    existing = db.execute(select(Video).where(Video.sha256 == digest)).scalar_one_or_none()
    if existing:
        # Дедупликация: повторная загрузка того же файла не плодит запись.
        response.status_code = 200
        return _out(db, existing)

    v = Video(sha256=digest, filename=file.filename or f"{digest[:12]}{suffix}",
              mime=mime, duration_s=0, width=0, height=0,
              size_bytes=len(data), storage_path="")
    db.add(v)
    db.flush()

    path = storage.video_path(v.id, suffix)
    path.write_bytes(data)
    v.storage_path = str(path)

    try:
        info = media.probe(path)
    except ApiError:
        path.unlink(missing_ok=True)
        db.rollback()
        raise

    if not (cfg.min_duration_s <= info["duration_s"] <= cfg.max_duration_s):
        path.unlink(missing_ok=True)
        db.rollback()
        raise ApiError(422, "video_duration_out_of_range", "Недопустимая длительность",
                       f"{info['duration_s']:.1f} с, допустимо "
                       f"{cfg.min_duration_s:.0f}–{cfg.max_duration_s:.0f} с")
    if info["height"] < cfg.min_height:
        path.unlink(missing_ok=True)
        db.rollback()
        raise ApiError(422, "video_resolution_too_low", "Недостаточное разрешение",
                       f"{info['width']}×{info['height']}, нужно от {cfg.min_height}p")

    v.duration_s = info["duration_s"]
    v.width, v.height, v.fps = info["width"], info["height"], info["fps"]
    db.commit()
    response.headers["Location"] = f"/api/v1/videos/{v.id}"
    return _out(db, v)


@router.get("/videos/{video_id}")
def get_one(video_id: UUID, db: Session = Depends(get_session)) -> dict:
    return _out(db, get_video(db, video_id))


@router.delete("/videos/{video_id}", status_code=204)
def delete_video(video_id: UUID, db: Session = Depends(get_session)) -> Response:
    v = get_video(db, video_id)
    pathlib.Path(v.storage_path).unlink(missing_ok=True)
    db.delete(v)
    db.commit()
    return Response(status_code=204)


_RANGE = re.compile(r"bytes=(\d*)-(\d*)")


@router.get("/videos/{video_id}/content")
def content(video_id: UUID, request: Request, db: Session = Depends(get_session)):
    """Отдача с Range, чтобы <video> перематывал без докачивания целиком."""
    v = get_video(db, video_id)
    path = pathlib.Path(v.storage_path)
    if not path.exists():
        raise ApiError(404, "video_not_found", "Файл ролика отсутствует")
    size = path.stat().st_size
    rng = request.headers.get("range")
    if not rng:
        return FileResponse(path, media_type=v.mime,
                            headers={"Accept-Ranges": "bytes"})
    m = _RANGE.match(rng)
    if not m:
        raise ApiError(416, "video_unreadable", "Некорректный Range")
    start = int(m.group(1) or 0)
    end = int(m.group(2)) if m.group(2) else size - 1
    end = min(end, size - 1)
    if start > end:
        raise ApiError(416, "video_unreadable", "Range за пределами файла")

    def chunks():
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                block = f.read(min(65536, left))
                if not block:
                    break
                left -= len(block)
                yield block

    return StreamingResponse(chunks(), status_code=206, media_type=v.mime, headers={
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1),
    })


@router.get("/videos/{video_id}/frame")
def frame(video_id: UUID, ts: float = Query(..., ge=0),
          w: int = Query(320, ge=16, le=1920), db: Session = Depends(get_session)):
    """Кадр по таймкоду. Кэшируется на диске: повторный запрос не декодирует заново."""
    v = get_video(db, video_id)
    if ts > v.duration_s:
        raise ApiError(422, "segment_out_of_bounds", "Таймкод за пределами ролика",
                       f"{ts} с при длительности {v.duration_s:.1f} с")
    out = storage.frame_path(v.id, ts, w)
    if not out.exists():
        media.extract_frame(pathlib.Path(v.storage_path), ts, w, out)
    return FileResponse(out, media_type="image/jpeg")


@router.get("/videos/{video_id}/annotation")
def video_annotation(video_id: UUID, response: Response,
                     db: Session = Depends(get_session)) -> dict:
    from ...serializers import annotation_out
    from .common import etag
    v = get_video(db, video_id)
    ann = latest_annotation(db, v.id)
    if not ann:
        raise ApiError(404, "annotation_not_found", "У ролика ещё нет разметки")
    response.headers["ETag"] = etag(ann)
    return annotation_out(ann, v.duration_s)
