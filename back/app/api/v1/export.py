import json
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import services
from ...db import get_session
from ...errors import ApiError
from ...models import Annotation, Segment, Video
from ...serializers import annotation_out
from .common import etag, get_annotation, get_video

router = APIRouter(tags=["export"])


@router.get("/annotations/{annotation_id}/export")
def export(annotation_id: UUID, format: str = Query(..., pattern="^(json|csv)$"),
           db: Session = Depends(get_session)) -> Response:
    """Валидация стоит перед отдачей: невалидный файл не выходит наружу вообще."""
    ann = get_annotation(db, annotation_id)
    v = get_video(db, ann.video_id)
    if not ann.segments:
        raise ApiError(422, "annotation_empty", "Выгружать нечего",
                       "В разметке нет ни одного шага.")

    payload = services.export_dict(ann, v)
    services.validate_export(payload)

    stem = services.pathlib_stem(v.filename)
    if format == "json":
        body = json.dumps(payload, ensure_ascii=False, indent=2)
        return Response(content=body, media_type="application/json", headers={
            "Content-Disposition": f'attachment; filename="{stem}.json"'})
    return Response(content=services.export_csv(payload), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{stem}.csv"'})


@router.post("/annotations/import", status_code=201)
def import_annotation(response: Response, payload: dict,
                      db: Session = Depends(get_session)) -> dict:
    """Обратная сторона экспорта: round-trip штатным путём API, а не скриптом."""
    services.validate_export(payload)
    stem = payload["video_id"]
    video = next((v for v in db.execute(select(Video)).scalars().all()
                  if services.pathlib_stem(v.filename) == stem), None)
    if not video:
        raise ApiError(404, "video_not_found", "Ролик из файла не загружен",
                       f"video_id={stem!r}: разметку не к чему привязать.")

    ann = Annotation(video_id=video.id, version=1, fps=payload.get("fps"),
                     model=payload.get("model", ""), meta=payload.get("meta", {}))
    for i, s in enumerate(payload["segments"]):
        ann.segments.append(Segment(
            index=i, start_s=s["start_s"], end_s=s["end_s"],
            action=s.get("action", ""), object=s.get("object", ""),
            tool=s.get("tool", ""), confidence=s.get("confidence"),
            keyframe_ts=s.get("keyframe_ts"),
            edited_by_human=bool(s.get("edited_by_human"))))
    db.add(ann)
    services.normalize(ann.segments, video.duration_s)
    db.commit()
    db.refresh(ann)
    response.headers["Location"] = f"/api/v1/annotations/{ann.id}"
    response.headers["ETag"] = etag(ann)
    return annotation_out(ann, video.duration_s)
