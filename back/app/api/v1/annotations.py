import pathlib
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header, Query, Response
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ... import media, services, storage
from ...db import get_session
from ...errors import ApiError
from ...models import Segment
from ...schemas import (AnnotationUpdate, MergeIn, SegmentIn, SegmentPatch,
                        SegmentsPatch, SplitIn)
from ...serializers import annotation_out
from .common import check_etag, etag, get_annotation, get_video

router = APIRouter(tags=["annotations"])


def _finish(db: Session, ann, response: Response) -> dict:
    """Общий хвост любой правки: инварианты, версия, ETag."""
    v = get_video(db, ann.video_id)
    services.normalize(ann.segments, v.duration_s)
    ann.version += 1
    db.commit()
    db.refresh(ann)
    response.headers["ETag"] = etag(ann)
    return annotation_out(ann, v.duration_s)


def _seg(ann, index: int) -> Segment:
    for s in ann.segments:
        if s.index == index:
            return s
    raise ApiError(404, "segment_not_found", "Шаг не найден",
                   f"индекс {index}, всего шагов {len(ann.segments)}")


@router.get("/annotations/{annotation_id}")
def get_one(annotation_id: UUID, response: Response,
            db: Session = Depends(get_session)) -> dict:
    ann = get_annotation(db, annotation_id)
    v = get_video(db, ann.video_id)
    response.headers["ETag"] = etag(ann)
    return annotation_out(ann, v.duration_s)


@router.put("/annotations/{annotation_id}")
def replace(annotation_id: UUID, response: Response, body: AnnotationUpdate,
            if_match: str | None = Header(default=None, alias="If-Match"),
            db: Session = Depends(get_session)) -> dict:
    """Автосейв редактора.

    Присланные index, needs_review и edited_by_human игнорируются: первые два
    производные, третий проставляет сервер — иначе флаг перестанет быть замером.
    """
    ann = get_annotation(db, annotation_id)
    check_etag(ann, if_match)
    was = {(round(s.start_s, 3), round(s.end_s, 3)): s for s in ann.segments}

    ann.segments.clear()
    db.flush()
    for i, s in enumerate(body.segments):
        prev = was.get((round(s.start_s, 3), round(s.end_s, 3)))
        changed = prev is None or (prev.action, prev.object, prev.tool) != (s.action, s.object, s.tool)
        ann.segments.append(Segment(
            index=i, start_s=s.start_s, end_s=s.end_s, action=s.action,
            object=s.object, tool=s.tool, confidence=s.confidence,
            keyframe_ts=s.keyframe_ts,
            edited_by_human=(prev.edited_by_human if prev else False) or changed))
    return _finish(db, ann, response)


@router.post("/annotations/{annotation_id}/segments", status_code=201)
def add_segment(annotation_id: UUID, response: Response, body: SegmentIn,
                if_match: str | None = Header(default=None, alias="If-Match"),
                db: Session = Depends(get_session)) -> dict:
    ann = get_annotation(db, annotation_id)
    check_etag(ann, if_match)
    ann.segments.append(Segment(
        index=len(ann.segments), start_s=body.start_s, end_s=body.end_s,
        action=body.action, object=body.object, tool=body.tool,
        keyframe_ts=body.keyframe_ts, edited_by_human=True))
    return _finish(db, ann, response)


@router.patch("/annotations/{annotation_id}/segments/{index}")
def patch_segment(annotation_id: UUID, index: int, response: Response,
                  body: SegmentPatch,
                  if_match: str | None = Header(default=None, alias="If-Match"),
                  db: Session = Depends(get_session)) -> dict:
    """Основная операция редактора.

    Ответ содержит всю разметку: правка границы может изменить порядок и
    нумерацию соседей.
    """
    ann = get_annotation(db, annotation_id)
    check_etag(ann, if_match)
    s = _seg(ann, index)
    for field, value in body.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(s, field, value)
    s.edited_by_human = True
    return _finish(db, ann, response)


@router.patch("/annotations/{annotation_id}/segments")
def patch_segments(annotation_id: UUID, response: Response, body: SegmentsPatch,
                   if_match: str | None = Header(default=None, alias="If-Match"),
                   db: Session = Depends(get_session)) -> dict:
    """Несколько правок одной транзакцией.

    Существует ради одного жеста редактора: протяжка границы двигает и сам шаг,
    и поджатого соседа. Двумя запросами это две версии и два повода разойтись —
    если второй не дойдёт, разметка останется с дырой или нахлёстом на том месте,
    где пользователь только что провёл мышью.

    Индексы в правках — нумерация ДО применения, поэтому все шаги находятся
    заранее, одним проходом, и только потом меняются. Инварианты проверяются
    один раз, на итоговом состоянии: промежуточного пересечения, из-за которого
    порядок правок был важен, здесь просто не возникает.
    """
    ann = get_annotation(db, annotation_id)
    check_etag(ann, if_match)

    seen: set[int] = set()
    for e in body.edits:
        if e.index in seen:
            raise ApiError(422, "validation_failed", "Шаг правится дважды",
                           f"индекс {e.index} встречается в списке больше одного раза")
        seen.add(e.index)

    targets = [(_seg(ann, e.index), e.patch) for e in body.edits]
    for s, patch in targets:
        for field, value in patch.model_dump(exclude_unset=True).items():
            if value is not None:
                setattr(s, field, value)
        s.edited_by_human = True
    return _finish(db, ann, response)


@router.delete("/annotations/{annotation_id}/segments/{index}")
def delete_segment(annotation_id: UUID, index: int, response: Response,
                   if_match: str | None = Header(default=None, alias="If-Match"),
                   db: Session = Depends(get_session)) -> dict:
    """Дыра во времени не заполняется: соседи остаются на своих границах."""
    ann = get_annotation(db, annotation_id)
    check_etag(ann, if_match)
    ann.segments.remove(_seg(ann, index))
    return _finish(db, ann, response)


@router.post("/annotations/{annotation_id}/segments/{index}/split")
def split(annotation_id: UUID, index: int, response: Response, body: SplitIn,
          if_match: str | None = Header(default=None, alias="If-Match"),
          db: Session = Depends(get_session)) -> dict:
    """Лечение недосегментации: модель склеила две контактные фазы в одну."""
    ann = get_annotation(db, annotation_id)
    check_etag(ann, if_match)
    s = _seg(ann, index)
    if not (s.start_s < body.at_s < s.end_s):
        raise ApiError(422, "segment_out_of_bounds", "Точка разреза вне шага",
                       f"{body.at_s} не внутри {s.start_s}..{s.end_s}")
    tail = Segment(index=s.index + 1, start_s=body.at_s, end_s=s.end_s,
                   action=s.action, object=s.object, tool=s.tool,
                   confidence=s.confidence, edited_by_human=True)
    s.end_s = body.at_s
    s.edited_by_human = True
    if s.keyframe_ts is not None and s.keyframe_ts > body.at_s:
        s.keyframe_ts = None
    ann.segments.append(tail)
    return _finish(db, ann, response)


@router.post("/annotations/{annotation_id}/segments/{index}/merge")
def merge(annotation_id: UUID, index: int, response: Response, body: MergeIn,
          if_match: str | None = Header(default=None, alias="If-Match"),
          db: Session = Depends(get_session)) -> dict:
    """Лечение пересегментации — одним жестом, а не тремя правками границ."""
    ann = get_annotation(db, annotation_id)
    check_etag(ann, if_match)
    s = _seg(ann, index)
    other_index = index - 1 if body.with_ == "prev" else index + 1
    other = _seg(ann, other_index)
    keep, drop = (s, other)
    keep.start_s = min(s.start_s, other.start_s)
    keep.end_s = max(s.end_s, other.end_s)
    keep.edited_by_human = True
    ann.segments.remove(drop)
    return _finish(db, ann, response)


@router.post("/annotations/{annotation_id}/review")
def mark_reviewed(annotation_id: UUID, response: Response,
                  if_match: str | None = Header(default=None, alias="If-Match"),
                  db: Session = Depends(get_session)) -> dict:
    """Отметить разметку проверенной целиком.

    Отдельное действие, а не вывод из данных: разметчик может согласиться с
    моделью, ничего не правя, и это тоже проверка.

    Флаг живёт только в API — канонический формат экспорта совпадает с
    hyp0/schema.py поле в поле, и своего поля там нет. Понадобится во внешних
    данных — поедет в `meta`, а не изменит схему.
    """
    ann = get_annotation(db, annotation_id)
    check_etag(ann, if_match)
    # Идемпотентно: повторный вызов оставляет ту же отметку, а не переписывает
    # время. Иначе «когда проверили» менялось бы от лишнего клика.
    if ann.reviewed_at is None:
        ann.reviewed_at = datetime.now(timezone.utc)
    return _finish(db, ann, response)


@router.delete("/annotations/{annotation_id}/review")
def unmark_reviewed(annotation_id: UUID, response: Response,
                    if_match: str | None = Header(default=None, alias="If-Match"),
                    db: Session = Depends(get_session)) -> dict:
    ann = get_annotation(db, annotation_id)
    check_etag(ann, if_match)
    ann.reviewed_at = None
    return _finish(db, ann, response)


@router.get("/annotations/{annotation_id}/segments/{index}/keyframe")
def keyframe(annotation_id: UUID, index: int, w: int = Query(320, ge=16, le=1920),
             db: Session = Depends(get_session)):
    ann = get_annotation(db, annotation_id)
    v = get_video(db, ann.video_id)
    s = _seg(ann, index)
    if s.keyframe_ts is None:
        raise ApiError(404, "segment_not_found", "У шага нет ключевого кадра")
    out = storage.frame_path(v.id, s.keyframe_ts, w)
    if not out.exists():
        media.extract_frame(pathlib.Path(v.storage_path), s.keyframe_ts, w, out)
    return FileResponse(out, media_type="image/jpeg")


@router.post("/annotations/{annotation_id}/segments/{index}/suggestions",
             status_code=501)
def suggestions(annotation_id: UUID, index: int, n: int = Body(default=3, embed=True)):
    """Этап 2. Контракт зафиксирован заранее — от подсказок зависит трёхкратное
    сокращение времени: разметчик, не согласный с моделью, должен получать
    список вариантов, а не пустое поле."""
    raise ApiError(501, "not_implemented", "Подсказки ещё не реализованы",
                   "Метод описан в контракте, реализация — этап 2.")
