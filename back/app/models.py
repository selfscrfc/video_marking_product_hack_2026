import uuid
from datetime import datetime, timezone

from sqlalchemy import (Boolean, CheckConstraint, DateTime, Float, ForeignKey,
                        Integer, String, Text, UniqueConstraint)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    sha256: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    filename: Mapped[str] = mapped_column(String(512))
    mime: Mapped[str] = mapped_column(String(64))
    duration_s: Mapped[float] = mapped_column(Float)
    fps: Mapped[float | None] = mapped_column(Float, nullable=True)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    size_bytes: Mapped[int] = mapped_column(Integer)
    storage_path: Mapped[str] = mapped_column(String(1024))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    jobs: Mapped[list["Job"]] = relationship(back_populates="video", cascade="all, delete-orphan")
    annotations: Mapped[list["Annotation"]] = relationship(
        back_populates="video", cascade="all, delete-orphan")


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (UniqueConstraint("video_id", "params_hash", name="jobs_video_params_uniq"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    video_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("videos.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    stage: Mapped[str | None] = mapped_column(String(32), nullable=True)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    params: Mapped[dict] = mapped_column(JSONB, default=dict)
    params_hash: Mapped[str] = mapped_column(String(64))
    model: Mapped[str] = mapped_column(String(128), default="marlin-2b")
    structure_model: Mapped[str] = mapped_column(String(128), default="")
    modal_call_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    raw_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    timings: Mapped[dict] = mapped_column(JSONB, default=dict)
    cost: Mapped[dict] = mapped_column(JSONB, default=dict)
    error: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # Стадии, которые не отработали, не уронив задачу. Отдельно от error,
    # потому что «упало» и «доехало неполным» — разные новости, а раньше и то
    # и другое лежало в error при status=succeeded и было неотличимо.
    degraded: Mapped[list] = mapped_column(JSONB, default=list)
    annotation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    video: Mapped[Video] = relationship(back_populates="jobs")


class Annotation(Base):
    __tablename__ = "annotations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    video_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("videos.id", ondelete="CASCADE"), index=True)
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    fps: Mapped[float | None] = mapped_column(Float, nullable=True)
    model: Mapped[str] = mapped_column(String(128), default="")
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)
    # Тот же список, что у задачи, но на артефакте: экран проверки держит
    # разметку и до задачи не дотягивается вовсе. Своей колонкой, а не в meta,
    # потому что meta уезжает в экспорт — а признак деградации в канонический
    # формат не входит.
    degraded: Mapped[list] = mapped_column(JSONB, default=list)
    # Отметка «проверено целиком». Живёт только в API: канонический формат
    # экспорта совпадает с hyp0/schema.py поле в поле, и своего поля там нет.
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    video: Mapped[Video] = relationship(back_populates="annotations")
    segments: Mapped[list["Segment"]] = relationship(
        back_populates="annotation", cascade="all, delete-orphan",
        order_by="Segment.index", lazy="selectin")


class Segment(Base):
    """Шаги строками, а не jsonb-блобом.

    edited_by_human — продуктовая метрика (какая доля разметки уходит без правок),
    её надо считать запросом по шагам, а не разбором json в приложении.
    """

    __tablename__ = "segments"
    __table_args__ = (
        # DEFERRABLE: переиндексация шагов временно нарушает уникальность —
        # шагу присваивается индекс, который в этот момент ещё занят соседом.
        # Проверять надо на коммите, когда перестановка закончена.
        UniqueConstraint("annotation_id", "index",
                         name="segments_annotation_index_uniq",
                         deferrable=True, initially="DEFERRED"),
        CheckConstraint("end_s > start_s", name="segments_positive_duration"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    annotation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("annotations.id", ondelete="CASCADE"), index=True)
    index: Mapped[int] = mapped_column(Integer)
    start_s: Mapped[float] = mapped_column(Float)
    end_s: Mapped[float] = mapped_column(Float)
    action: Mapped[str] = mapped_column(Text, default="")
    object: Mapped[str] = mapped_column(Text, default="")
    tool: Mapped[str] = mapped_column(Text, default="")
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    keyframe_ts: Mapped[float | None] = mapped_column(Float, nullable=True)
    edited_by_human: Mapped[bool] = mapped_column(Boolean, default=False)

    annotation: Mapped[Annotation] = relationship(back_populates="segments")
