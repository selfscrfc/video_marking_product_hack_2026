"""Marlin-2B на Modal: ролик на вход, события с таймкодами на выход.

Деплой:
    modal deploy back/modal_app/marlin.py

Перед первым деплоем нужны:
  * авторизация Modal            — modal setup
  * секрет с токеном HF          — модель в gated-репозитории (авто-апрув)
  * один прогон download_weights — иначе веса поедут на первом же инференсе
                                   и съедят бюджет холодным стартом

Каталог называется modal_app, а не modal: пакет с таким именем затенил бы сам
клиент Modal при запуске из back/.
"""
from __future__ import annotations

import time

import modal

APP_NAME = "sirochek-marlin"
REPO = "NemoStation/Marlin-2B"

# 2B в bf16 — это ~5 ГБ весов плюс кадры видео. A10G (24 ГБ) берём с запасом;
# L4 дешевле и тоже подходит, T4 (16 ГБ) — на грани, проверять замером.
GPU = "A10G"

# Родной caption-режим: модель обучена на это, свой JSON-промпт ей не навязываем.
CAPTION_PROMPT = (
    # Канонический промпт обучения, дословно из modeling_marlin.py, где он
    # помечен «DO NOT EDIT»: строки обязаны совпадать с тем, на чём модель
    # дообучали. Раньше здесь стоял пересказ своими словами, и на части
    # роликов модель уходила в режим поиска момента — отвечала событиями
    # без таймкодов, а разбор падал в model_parse_failed.
    "Provide a spatial description of this clip followed by time-ranged events.\n"
    "For each event, give the time range as <start - end> and a short description."
)

# Веса лежат в томе, а не в образе: образ пересобирается при каждой правке кода,
# а 5 ГБ весов пересобирать незачем.
cache = modal.Volume.from_name("sirochek-hf-cache", create_if_missing=True)
CACHE_DIR = "/cache"

# Репозиторий gated — без токена snapshot_download вернёт 401.
hf_secret = modal.Secret.from_name("huggingface")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install(
        # версии те же, что в локальном venv, чтобы поведение совпадало с run_marlin.py
        "torch==2.14.0",
        # Marlin построена на Qwen3-VL, и её Qwen3VLVideoProcessor импортирует
        # torchvision. Без него контейнер падает на загрузке процессора.
        "torchvision",
        "transformers==5.16.1",
        "accelerate",
        "huggingface_hub",
        "av",           # запасной бэкенд декодирования
        "torchcodec",   # основной: его просит run_marlin.py
        "numpy",
        "pillow",
    )
    # Быструю загрузку даёт hf-xet, который huggingface_hub 1.30 ставит сам.
    # HF_HUB_ENABLE_HF_TRANSFER здесь не выставляем: без одноимённого пакета
    # эта переменная роняет загрузку, а пакет вытеснен xet.
    .env({"HF_HOME": CACHE_DIR})
)

app = modal.App(APP_NAME)


@app.function(
    image=image,
    volumes={CACHE_DIR: cache},
    secrets=[hf_secret],
    timeout=60 * 60,
)
def download_weights() -> dict:
    """Кладёт веса в том. Запускать один раз после деплоя."""
    from huggingface_hub import snapshot_download

    t0 = time.time()
    path = snapshot_download(REPO, cache_dir=f"{CACHE_DIR}/hub")
    cache.commit()
    size = sum(f.stat().st_size for f in __import__("pathlib").Path(path).rglob("*") if f.is_file())
    return {"path": path, "seconds": round(time.time() - t0, 1),
            "gib": round(size / 1024**3, 2)}


@app.cls(
    image=image,
    gpu=GPU,
    volumes={CACHE_DIR: cache},
    secrets=[hf_secret],
    timeout=60 * 10,
    # Ролик обязан размечаться за 2 минуты, а загрузка модели занимает десятки
    # секунд. На время демо ставится min_containers=1, чтобы холодный старт не
    # съедал бюджет; в покое держать тёплый контейнер незачем — он платный.
    min_containers=0,
    scaledown_window=60 * 5,
)
class Marlin:

    @modal.enter()
    def load(self) -> None:
        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor

        t0 = time.time()
        self.processor = AutoProcessor.from_pretrained(REPO, trust_remote_code=True)
        self.model = (
            AutoModelForCausalLM.from_pretrained(
                REPO, dtype=torch.bfloat16, trust_remote_code=True
            )
            .to("cuda")
            .eval()
        )
        self.load_seconds = round(time.time() - t0, 1)
        print(f"модель загружена за {self.load_seconds} с")

    def _build_inputs(self, video_path: str, prompt: str, fps: float):
        """Точный вызов процессора у модели с custom_code заранее не известен.

        Пробуем варианты по очереди и возвращаем тот, что сработал, — та же
        логика, что в hyp0/run_marlin.py, чтобы поведение совпадало.
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
                inputs = self.processor.apply_chat_template(
                    msgs, add_generation_prompt=True, tokenize=True,
                    return_dict=True, return_tensors="pt", **extra,
                )
                return inputs.to("cuda"), how
            except Exception as e:  # noqa: BLE001
                errors.append(f"{how}: {type(e).__name__}: {e}")
        raise RuntimeError("не удалось собрать вход:\n  " + "\n  ".join(errors))

    @modal.method()
    def annotate(
        self,
        video_bytes: bytes,
        fps: float = 2.0,
        max_new_tokens: int = 512,
        prompt: str = CAPTION_PROMPT,
        suffix: str = ".mp4",
    ) -> dict:
        """Сырой ответ модели. Разбор — на стороне воркера (hyp0/parse.py)."""
        import tempfile
        import torch

        t0 = time.time()
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(video_bytes)
            path = f.name

        inputs, how = self._build_inputs(path, prompt, fps)
        t_prep = time.time()

        with torch.inference_mode():
            out = self.model.generate(**inputs, max_new_tokens=max_new_tokens,
                                      do_sample=False)
        n_in = inputs["input_ids"].shape[1]
        text = self.processor.batch_decode(out[:, n_in:], skip_special_tokens=True)[0]

        return {
            "text": text,
            "how": how,
            "gpu": GPU,
            "timings": {
                "prepare": round(t_prep - t0, 2),
                "generate": round(time.time() - t_prep, 2),
                "total": round(time.time() - t0, 2),
            },
        }


@app.local_entrypoint()
def main(clip: str = "hyp0/clips/asm_static_00.mp4", fps: float = 2.0,
         max_new_tokens: int = 512) -> None:
    """Дымовой прогон одного ролика: modal run back/modal_app/marlin.py --clip ..."""
    import pathlib

    p = pathlib.Path(clip)
    data = p.read_bytes()
    print(f"{p.name}: {len(data)/1024**2:.1f} МБ -> {APP_NAME} ({GPU})")

    t0 = time.time()
    res = Marlin().annotate.remote(data, fps=fps, max_new_tokens=max_new_tokens,
                                   suffix=p.suffix)
    print(f"\nвход собран через: {res['how']}")
    print(f"тайминги на стороне GPU: {res['timings']}")
    print(f"полное время с локальной стороны: {time.time()-t0:.1f} с "
          f"(бюджет кейса 120 с)\n")
    print("--- сырой ответ ---")
    print(res["text"])
