"""Вызов Marlin-2B на Modal.

Ходим через modal.Cls.from_name — тем же путём, что и любой другой клиент
развёрнутого приложения.
"""
import os

from app.config import settings


def _auth() -> None:
    cfg = settings()
    if cfg.modal_token_id and cfg.modal_token_secret:
        os.environ.setdefault("MODAL_TOKEN_ID", cfg.modal_token_id)
        os.environ.setdefault("MODAL_TOKEN_SECRET", cfg.modal_token_secret)


def annotate(video_bytes: bytes, *, fps: float, max_new_tokens: int,
             suffix: str = ".mp4") -> dict:
    import modal

    _auth()
    cfg = settings()
    marlin = modal.Cls.from_name(cfg.modal_app_name, "Marlin")()
    return marlin.annotate.remote(video_bytes, fps=fps,
                                  max_new_tokens=max_new_tokens, suffix=suffix)
