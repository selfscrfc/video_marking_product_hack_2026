from uuid import UUID

from fastapi import Header
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...errors import ApiError
from ...models import Annotation, Job, Video


def get_video(db: Session, video_id: UUID) -> Video:
    v = db.get(Video, video_id)
    if not v:
        raise ApiError(404, "video_not_found", "Ролик не найден")
    return v


def get_job(db: Session, job_id: UUID) -> Job:
    j = db.get(Job, job_id)
    if not j:
        raise ApiError(404, "job_not_found", "Задача не найдена")
    return j


def get_annotation(db: Session, annotation_id: UUID) -> Annotation:
    a = db.get(Annotation, annotation_id)
    if not a:
        raise ApiError(404, "annotation_not_found", "Разметка не найдена")
    return a


def latest_annotation(db: Session, video_id: UUID) -> Annotation | None:
    return db.execute(
        select(Annotation).where(Annotation.video_id == video_id)
        .order_by(Annotation.updated_at.desc()).limit(1)
    ).scalar_one_or_none()


def check_etag(ann: Annotation, if_match: str | None) -> None:
    """Защита от затирания чужих правок.

    Клиент обязан прислать версию из ETag. Устарела — 409, и перечитать, а не
    повторять запрос: иначе слепой повтор затрёт чужую работу.
    """
    if not if_match:
        raise ApiError(428, "version_missing", "Не передан If-Match",
                       f'Текущая версия разметки — "{ann.version}".')
    got = if_match.strip().strip('"').lstrip("W/").strip('"')
    if got != str(ann.version):
        raise ApiError(409, "version_conflict", "Разметку изменили параллельно",
                       f'Ваша версия {got}, текущая {ann.version}. Перечитайте разметку.')


def etag(ann: Annotation) -> str:
    return f'"{ann.version}"'


IfMatch = Header(default=None, alias="If-Match")
