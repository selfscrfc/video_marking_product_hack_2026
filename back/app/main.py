import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

from .api.v1 import annotations, export, jobs, service, videos
from .config import settings
from .db import init_db
from .errors import ApiError, api_error_handler, problem

log = logging.getLogger("sirochek")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    log.info("схема готова")
    yield


app = FastAPI(
    title="Sirochek — автоматическая разметка действий по видео",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    openapi_url="/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings().cors_origins.split(",") if o.strip()],
    allow_methods=["*"], allow_headers=["*"], expose_headers=["ETag", "Location"],
)

app.add_exception_handler(ApiError, api_error_handler)


@app.exception_handler(RequestValidationError)
async def validation_handler(request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422, media_type="application/problem+json",
        content=problem(422, "validation_failed", "Тело запроса не проходит проверку",
                        errors=[{"pointer": "/" + "/".join(str(p) for p in e["loc"][1:]),
                                 "message": e["msg"]} for e in exc.errors()],
                        instance=str(request.url.path)))


@app.exception_handler(IntegrityError)
async def integrity_handler(request, exc: IntegrityError):
    """Последний рубеж: ограничения базы не должны выглядеть как сбой сервиса."""
    text = str(getattr(exc, "orig", exc))
    if "segments_no_overlap" in text:
        code, title = "segment_overlap", "Границы шагов пересекаются"
    elif "segments_positive_duration" in text:
        code, title = "segment_inverted", "Конец шага не больше начала"
    else:
        code, title = "validation_failed", "Данные нарушают ограничение базы"
    return JSONResponse(status_code=422, media_type="application/problem+json",
                        content=problem(422, code, title, text[:300],
                                        instance=str(request.url.path)))


for r in (service.router, videos.router, jobs.router, annotations.router, export.router):
    app.include_router(r, prefix="/api/v1")
