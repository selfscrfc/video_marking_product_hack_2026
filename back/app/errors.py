"""Ошибки в формате RFC 9457. Клиент ветвится по code, а не по тексту."""
from fastapi import Request
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, status: int, code: str, title: str,
                 detail: str = "", errors: list[dict] | None = None):
        self.status, self.code, self.title = status, code, title
        self.detail, self.errors = detail, errors or []


def problem(status: int, code: str, title: str, detail: str = "",
            errors: list[dict] | None = None, instance: str = "") -> dict:
    body = {"type": "about:blank", "title": title, "status": status, "code": code}
    if detail:
        body["detail"] = detail
    if errors:
        body["errors"] = errors
    if instance:
        body["instance"] = instance
    return body


async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        media_type="application/problem+json",
        content=problem(exc.status, exc.code, exc.title, exc.detail,
                        exc.errors, str(request.url.path)),
    )
