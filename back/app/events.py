"""Канал прогресса: воркер публикует, api ретранслирует в SSE.

Опрос GET /jobs/{id} читает таблицу и живёт независимо — если redis отвалится,
деградирует только поток событий, а не обработка.
"""
import json

import redis
import redis.asyncio as aredis

from .config import settings


def channel(job_id) -> str:
    return f"job:{job_id}"


def publish(job_id, event: str, data: dict) -> None:
    try:
        r = redis.from_url(settings().redis_url)
        r.publish(channel(job_id), json.dumps({"event": event, "data": data}))
        r.close()
    except Exception:  # noqa: BLE001 — прогресс не должен ронять обработку
        pass


async def subscribe(job_id):
    r = aredis.from_url(settings().redis_url)
    ps = r.pubsub()
    await ps.subscribe(channel(job_id))
    try:
        async for msg in ps.listen():
            if msg.get("type") == "message":
                yield json.loads(msg["data"])
    finally:
        await ps.unsubscribe(channel(job_id))
        await ps.aclose()
        await r.aclose()
