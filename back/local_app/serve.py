"""Marlin-2B на локальной машине: тот же контракт, что у Modal.

Существует потому, что Docker на macOS не пробрасывает MPS: воркер живёт в
контейнере, а модель обязана считаться на хосте. Отсюда HTTP между ними —
воркер ходит на host.docker.internal, как ходил бы на любой внешний провайдер.

Запуск (с хоста, не из контейнера):
    HF_HUB_CACHE=hf_cache/hub PYTORCH_ENABLE_MPS_FALLBACK=1 \
        venv/bin/python -m uvicorn local_app.serve:app --host 0.0.0.0 --port 8100

`--host 0.0.0.0` обязателен: на loopback контейнер не достучится, ему видно
только внешний интерфейс хоста.

Замер на M4 Pro: загрузка модели 11.6 с однократно, дальше 26–29 с на ролик
при бюджете кейса 120. Тёплая всегда, в отличие от Modal, где каждый холодный
старт стоил тридцати секунд и платного контейнера в простое.
"""
from __future__ import annotations

import os
import tempfile
import time
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

REPO = "NemoStation/Marlin-2B"

# Родной caption-режим: модель обучена на это, свой JSON-промпт ей не навязываем.
CAPTION_PROMPT = "Describe the video with a scene summary and timestamped events."

DEVICE = os.environ.get("LOCAL_DEVICE", "mps")

_state: dict = {}


def _load() -> None:
    from transformers import AutoModelForCausalLM, AutoProcessor

    t0 = time.time()
    dtype = torch.bfloat16 if DEVICE != "cpu" else torch.float32
    _state["processor"] = AutoProcessor.from_pretrained(REPO, trust_remote_code=True)
    _state["model"] = (
        AutoModelForCausalLM.from_pretrained(REPO, dtype=dtype, trust_remote_code=True)
        .to(DEVICE)
        .eval()
    )
    _state["load_seconds"] = round(time.time() - t0, 1)
    print(f"модель загружена за {_state['load_seconds']} с на {DEVICE}", flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Грузим на старте, а не по первому запросу: иначе первый ролик пользователя
    # оплачивает загрузку и выглядит как зависшая обработка.
    _load()
    yield


app = FastAPI(title="Marlin-2B локально", lifespan=lifespan)


def _build_inputs(processor, video_path: str, prompt: str, fps: float):
    """Перебор вариантов вызова — тот же, что в modal_app/marlin.py.

    Точный вызов процессора у модели с custom_code заранее не известен, а на
    разных версиях transformers работает разное.
    """
    msgs = [{"role": "user", "content": [
        {"type": "video", "video": video_path, "fps": fps},
        {"type": "text", "text": prompt},
    ]}]
    attempts = [
        ("chat_template+torchcodec", dict(video_load_backend="torchcodec")),
        ("chat_template+pyav", dict(video_load_backend="pyav")),
        ("chat_template", {}),
    ]
    errors = []
    for how, extra in attempts:
        try:
            inputs = processor.apply_chat_template(
                msgs, add_generation_prompt=True, tokenize=True,
                return_dict=True, return_tensors="pt", **extra)
            return inputs.to(DEVICE), how
        except Exception as e:  # noqa: BLE001
            errors.append(f"{how}: {type(e).__name__}: {e}")
    raise RuntimeError("не удалось собрать вход:\n  " + "\n  ".join(errors))


@app.get("/health")
def health() -> dict:
    return {
        "ready": "model" in _state,
        "device": DEVICE,
        "load_seconds": _state.get("load_seconds"),
    }


@app.post("/annotate")
async def annotate(request: Request) -> JSONResponse:
    """Ролик приходит сырыми байтами в теле, параметры — в query.

    Байтами, а не base64: между контейнером и хостом это локальная сеть, и
    раздувать десять мегабайт на треть незачем.
    """
    if "model" not in _state:
        return JSONResponse({"error": "модель ещё грузится"}, status_code=503)

    q = request.query_params
    fps = float(q.get("fps", 2.0))
    max_new_tokens = int(q.get("max_new_tokens", 512))
    suffix = q.get("suffix") or ".mp4"
    prompt = q.get("prompt") or CAPTION_PROMPT

    data = await request.body()
    if not data:
        return JSONResponse({"error": "пустое тело запроса"}, status_code=422)

    t0 = time.time()
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(data)
        path = f.name

    try:
        processor, model = _state["processor"], _state["model"]
        inputs, how = _build_inputs(processor, path, prompt, fps)
        if DEVICE == "mps":
            torch.mps.synchronize()
        t_prep = time.time()

        with torch.inference_mode():
            out = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
        if DEVICE == "mps":
            torch.mps.synchronize()

        n_in = inputs["input_ids"].shape[1]
        text = processor.batch_decode(out[:, n_in:], skip_special_tokens=True)[0]
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"{type(e).__name__}: {e}"}, status_code=500)
    finally:
        os.unlink(path)

    return JSONResponse({
        "text": text,
        "how": how,
        # То же поле, что у Modal: там имя карты, здесь имя устройства. По нему
        # в задаче видно, кто считал.
        "gpu": DEVICE,
        "timings": {
            "prepare": round(t_prep - t0, 2),
            "generate": round(time.time() - t_prep, 2),
            "total": round(time.time() - t0, 2),
        },
    })
