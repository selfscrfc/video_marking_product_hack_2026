from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class VideoOut(BaseModel):
    video_id: UUID
    filename: str
    mime: str
    duration_s: float
    fps: float | None = None
    width: int
    height: int
    size_bytes: int
    sha256: str
    created_at: datetime
    latest_annotation_id: UUID | None = None
    latest_job_id: UUID | None = None


class JobParams(BaseModel):
    fps: float = 2.0
    max_new_tokens: int = 512
    prompt_mode: str = "caption"
    min_segment_s: float = 0.4
    merge_threshold: float = 0.9


class JobCreate(BaseModel):
    profile: str = "contact_phase"
    structure_model: str | None = None
    params: JobParams = Field(default_factory=JobParams)
    force: bool = False


class JobOut(BaseModel):
    job_id: UUID
    video_id: UUID
    status: str
    stage: str | None = None
    stage_index: int | None = None
    stages: list[str]
    progress: float
    eta_s: float | None = None
    annotation_id: UUID | None = None
    params: dict
    model: str
    structure_model: str
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    timings: dict
    cost: dict
    error: dict | None = None
    raw_response_url: str | None = None


class SegmentOut(BaseModel):
    index: int
    start_s: float
    end_s: float
    action: str
    object: str
    tool: str
    confidence: float | None = None
    keyframe_ts: float | None = None
    keyframe_url: str | None = None
    edited_by_human: bool
    needs_review: bool


class AnnotationOut(BaseModel):
    annotation_id: UUID
    video_id: UUID
    job_id: UUID | None = None
    duration_s: float
    fps: float | None = None
    model: str
    version: int
    segments: list[SegmentOut]
    meta: dict
    created_at: datetime
    updated_at: datetime
    stats: dict


class SegmentIn(BaseModel):
    start_s: float
    end_s: float
    action: str = ""
    object: str = ""
    tool: str = ""
    confidence: float | None = None
    keyframe_ts: float | None = None


class AnnotationUpdate(BaseModel):
    segments: list[SegmentIn] = Field(min_length=1)


class SegmentPatch(BaseModel):
    start_s: float | None = None
    end_s: float | None = None
    action: str | None = None
    object: str | None = None
    tool: str | None = None
    keyframe_ts: float | None = None


class SegmentEdit(BaseModel):
    index: int
    patch: SegmentPatch


class SegmentsPatch(BaseModel):
    """Несколько правок одним действием.

    `index` — нумерация ДО правки: клиент видел именно её, когда собирал список.
    """

    edits: list[SegmentEdit] = Field(min_length=1)


class SplitIn(BaseModel):
    at_s: float


class MergeIn(BaseModel):
    with_: str = Field(alias="with")
