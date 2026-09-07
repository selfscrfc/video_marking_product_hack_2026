import json
import time

from fastapi import APIRouter, Response
from sqlalchemy import text

from ...config import settings
from ...db import engine
from ...services import _schema

router = APIRouter(tags=["service"])
_STARTED = time.time()


@router.get("/health")
def health(response: Response) -> dict:
    cfg = settings()
    db_ok = True
    try:
        with engine.connect() as c:
            c.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001
        db_ok = False

    queue_ok = True
    worker_seen = None
    try:
        import redis
        r = redis.from_url(cfg.redis_url)
        r.ping()
        hb = r.get("worker:heartbeat")
        worker_seen = round(time.time() - float(hb), 1) if hb else None
        r.close()
    except Exception:  # noqa: BLE001
        queue_ok = False

    # Проверяем то, что настроено, а не то, что когда-то было основным путём.
    # Раньше здесь стояли токены Modal безусловно, и стек с локальной моделью
    # рапортовал ready: false при полностью рабочем конвейере.
    providers = []
    for name in (p.strip().lower() for p in cfg.inference_providers.split(",")):
        if name == "modal":
            providers.append({
                "name": "modal",
                "ready": bool(cfg.modal_token_id and cfg.modal_token_secret),
                "detail": cfg.modal_app_name,
            })
        elif name == "local":
            ok = False
            try:
                import httpx
                ok = bool(httpx.get(f"{cfg.local_inference_url.rstrip('/')}/health",
                                    timeout=2).json().get("ready"))
            except Exception:  # noqa: BLE001 — недоступен, это и есть ответ
                ok = False
            providers.append({
                "name": "local", "ready": ok, "detail": cfg.local_inference_url,
            })

    # Достаточно одного рабочего: список и заведён затем, чтобы отказ любого
    # из них не останавливал обработку.
    inference_ok = any(p["ready"] for p in providers)
    qwen_ok = False
    try:
        import httpx
        qwen_ok = httpx.get(
            f"{cfg.llm_base_url.rstrip('/')}/models",
            headers={"Authorization": f"Bearer {cfg.llm_api_key}"},
            timeout=2,
        ).is_success
    except Exception:  # noqa: BLE001 — состояние отражается в health
        qwen_ok = False

    ready = (
        db_ok
        and inference_ok
        and qwen_ok
        and worker_seen is not None
        and worker_seen < 60
    )
    if not ready:
        response.status_code = 503
    return {
        "ready": ready, "version": "0.1.0",
        "database": db_ok, "queue": queue_ok,
        "worker_seen_s_ago": worker_seen,
        "inference": providers,
        "structure": {
            "ready": qwen_ok,
            "provider": cfg.llm_provider,
            "model": cfg.structure_model,
        },
        "uptime_s": round(time.time() - _STARTED, 1),
    }


@router.get("/config")
def client_config() -> dict:
    """Лимиты фронт читает отсюда и не хардкодит.

    Иначе подпись в дропзоне разъедется с тем, что реально проверяет сервер.
    """
    cfg = settings()
    return {
        "min_duration_s": cfg.min_duration_s,
        "max_duration_s": cfg.max_duration_s,
        "min_height": cfg.min_height,
        "accepted_mime": ["video/mp4", "video/quicktime"],
        "max_size_bytes": cfg.max_upload_bytes,
        "confidence_threshold": cfg.confidence_threshold,
        "min_segment_s": cfg.min_segment_s,
        "profiles": [
            {"id": "contact_phase", "title": "Контактные фазы",
             "description": "Один шаг — одна контактная фаза: подвести руку, взять, "
                            "переместить, поставить, отпустить."},
            {"id": "coarse", "title": "Крупные шаги",
             "description": "Обзорная разметка: несколько крупных этапов на ролик."},
        ],
        "structure_models": [cfg.structure_model],
    }


@router.get("/schema/annotation.json")
def annotation_schema() -> Response:
    return Response(content=json.dumps(_schema(), ensure_ascii=False, indent=2),
                    media_type="application/schema+json")
