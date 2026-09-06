"""Канонический формат разметки.

Копия hyp0/schema.py. Держится копией, а не импортом, потому что hyp0 лежит вне
этого репозитория и вне контекста сборки образа. Набор полей обязан совпадать:
на нём держится то, что выгрузку из приложения можно скормить hyp0/metrics.py
без конвертера.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Segment:
    """Один шаг разметки. Один шаг = одна контактная фаза."""

    start_s: float
    end_s: float
    action: str = ""
    object: str = ""
    tool: str = ""
    confidence: float | None = None
    keyframe_ts: float | None = None
    edited_by_human: bool = False

    def __post_init__(self) -> None:
        if self.end_s < self.start_s:
            raise ValueError(f"end_s < start_s: {self.start_s} .. {self.end_s}")

    @property
    def duration(self) -> float:
        return self.end_s - self.start_s

    def text(self) -> str:
        """Каноническая форма «глагол + объект» для сверки с таргетом."""
        return " ".join(p for p in (self.action, self.object) if p).strip()


@dataclass
class Annotation:
    video_id: str
    duration_s: float
    segments: list[Segment] = field(default_factory=list)
    fps: float | None = None
    model: str = ""
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Annotation":
        segs = [Segment(**s) for s in d.get("segments", [])]
        return cls(video_id=d["video_id"], duration_s=d["duration_s"], segments=segs,
                   fps=d.get("fps"), model=d.get("model", ""), meta=d.get("meta", {}))
