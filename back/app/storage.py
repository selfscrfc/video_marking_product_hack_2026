"""Файловое хранилище за интерфейсом: сегодня общий том, завтра S3."""
import hashlib
import pathlib

from .config import settings


def root() -> pathlib.Path:
    p = pathlib.Path(settings().media_root)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _sub(name: str) -> pathlib.Path:
    p = root() / name
    p.mkdir(parents=True, exist_ok=True)
    return p


def video_path(video_id, suffix: str) -> pathlib.Path:
    return _sub("videos") / f"{video_id}{suffix}"


def frame_path(video_id, ts: float, w: int) -> pathlib.Path:
    d = _sub("frames") / str(video_id)
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{ts:.3f}_{w}.jpg"


def raw_path(job_id) -> pathlib.Path:
    return _sub("raw") / f"{job_id}.txt"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
