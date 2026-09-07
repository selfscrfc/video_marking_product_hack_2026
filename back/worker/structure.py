"""Стадия structure: описание одной строкой → действие, объект, инструмент.

Marlin не разделяет глагол и объект — она отдаёт «The person holds the yellow toy
car with both hands» целиком. Кейс требует поля раздельно и меряет обе колонки,
поэтому нужен отдельный проход. Видео он не видит: на вход идут только строки,
которые модель уже вернула.

По умолчанию используется локальный Qwen3-4B-Instruct, поднятый через vLLM с
OpenAI-совместимым API. Видео Qwen не получает и границы Marlin не меняет.

Один запрос на весь ролик, а не по строке: модель видит соседние шаги и держит
формулировки однообразными, а узкий разброс формы прямо повышает шанс совпадения
с таргетом при оценке.
"""
from __future__ import annotations

import json
import logging

from app.config import settings

log = logging.getLogger("worker.structure")

# Взаимодействие с моделями унифицировано на английский. Русский оригинал
# критерия гранулярности живёт в hyp0/prompt.py; два текста обязаны говорить об
# одном и том же, иначе метрика начнёт мерить рассогласование документов.
GRANULARITY = (
    "A step is one contact phase — about as long as reaching for something, taking "
    "it, moving it or putting it down. Do not generalise to the whole scenario and "
    "do not split into individual finger movements. This describes the SIZE of a "
    "step, not a list of allowed verbs."
    # Последняя фраза не украшение. Пока перечисление фаз стояло без неё, модель
    # читала его как закрытый словарь и возвращала -1 на всё, что в него не
    # попало, честно понизив уверенность. Критерий задаёт размер шага, а не
    # набор глаголов.
    #
    # Примеров глаголов здесь нет намеренно. Раньше они были ("hold", "unscrew",
    # "place") и оказались глаголами сборки: на роликах Assembly101 всё сходилось,
    # на кухонном половина шагов осталась без действия. Замер показал, что с
    # нейтральной формулировкой словарь получается тот же, а домен перестаёт
    # протекать в инструкцию. Домен продукта заранее неизвестен — разметка
    # zero-shot, — и любой пример здесь становится подсказкой в одну сторону.
)

SYSTEM = f"""You normalise video annotation steps into a fixed shape.

The input is a numbered list of steps, each described by one sentence.

{GRANULARITY}

Work in two stages.

1. Build the vocabulary of the whole clip:
   - `actions`: the distinct actions performed, each a single verb in base form.
     Take the verb from what the step actually describes; the vocabulary is built from
     this clip and is not chosen from any fixed list. The same physical action gets one
     entry, reused by every step that performs it.
   - `objects`: the distinct physical objects handled, each a short bare noun phrase.
     Drop descriptive adjectives such as colour or size ("yellow toy car" -> "toy car")
     unless the adjective is what tells two objects of this clip apart. A part of an
     object is a separate entry only when steps act on it separately.
   - `tools`: instruments used on the objects. A tool is never a body part and never
     the object being worked on. Leave the list empty when no tool appears.

2. Label every step with indices into those lists: `action_id`, `object_id` and
   `tool_id` (-1 when no tool is involved), plus a `confidence`.

Rules:
- Use -1 for an id that cannot be made out, and lower the confidence. Do not guess.
- confidence must reflect real uncertainty. Do not return 1.0 for every step.
- Answer in {{lang}}.
- Never change the number or the order of the steps: return as many as you received."""

# Шаги ссылаются на словарь индексами, а не повторяют строки. Так модель не может
# назвать один и тот же предмет тремя способами: вариантов написания просто нет.
SCHEMA = {
    "type": "object",
    "properties": {
        "actions": {"type": "array", "items": {"type": "string"}},
        "objects": {"type": "array", "items": {"type": "string"}},
        "tools": {"type": "array", "items": {"type": "string"}},
        "steps": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "action_id": {"type": "integer"},
                    "object_id": {"type": "integer"},
                    "tool_id": {"type": "integer"},
                    "confidence": {"type": "number"},
                },
                "required": ["index", "action_id", "object_id", "tool_id", "confidence"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["actions", "objects", "tools", "steps"],
    "additionalProperties": False,
}


def _lang_instruction() -> str:
    """Язык результата. По умолчанию английский — на нём отвечает Marlin и на нём
    же размечен Assembly101, так что лишнего перевода в контуре нет."""
    mode = settings().structure_lang
    if mode == "ru":
        return "Russian"
    if mode == "en":
        return "English"
    return "the same language as the input description"


def structure(descriptions: list[str]) -> tuple[list[dict], dict]:
    """Возвращает (шаги, метрика стоимости). Пустой вход — пустой выход."""
    if not descriptions:
        return [], {}

    from openai import OpenAI

    cfg = settings()
    # Таймаут обязателен. Стадия обычно занимает 2–5 с, но на обрыве связи
    # клиент по умолчанию сидит с ретраями минутами: один такой случай съел
    # 587 секунд при бюджете кейса в 120, и задача выглядела зависшей.
    # Лучше признать деградацию быстро, чем держать пользователя в неведении.
    client = OpenAI(api_key=cfg.llm_api_key, base_url=cfg.llm_base_url,
                    timeout=cfg.llm_timeout_s, max_retries=1)

    listing = "\n".join(f"{i}. {d}" for i, d in enumerate(descriptions))

    messages = [
        {"role": "system", "content": SYSTEM.replace("{lang}", _lang_instruction())},
        {"role": "user", "content": f"Steps of the clip:\n{listing}"},
    ]

    def call(max_tokens: int):
        return client.chat.completions.create(
            model=cfg.structure_model,
            max_tokens=max_tokens,
            messages=messages,
            response_format={
                "type": "json_schema",
                "json_schema": {"name": "steps", "strict": True, "schema": SCHEMA},
            },
            temperature=0,
        )

    # Потолок вывода считаем от числа шагов, а не оставляем максимум модели:
    # без него провайдер резервирует максимум и может отказать по балансу.
    #
    # Лимит растёт с числом шагов: Qwen должен вернуть словари и ровно одну
    # индексную запись на каждый входной сегмент.
    # Провал стадии не роняет задачу: наружу уходит сырое предложение Marlin в
    # `action` и пустой `object`. То есть незамеченная нехватка потолка стоила
    # ровно того требования, ради которого стадия и заведена.
    try:
        resp = call(min(8000, 1200 + 500 * len(descriptions)))
    except Exception as e:  # noqa: BLE001
        # Обрезание по потолку провайдер отдаёт как ошибку запроса, а не как
        # усечённый ответ. Один повтор с максимумом: рассуждение бывает длинным
        # на ровном месте, и второй прогон того же промпта обычно короче.
        if "json_validate_failed" not in str(e):
            raise
        log.warning("structure: ответ не уложился в потолок, повтор с максимумом")
        resp = call(8000)

    data = json.loads(resp.choices[0].message.content)
    vocab = {k: [str(x).strip() for x in data.get(k, [])]
             for k in ("actions", "objects", "tools")}

    def pick(kind: str, idx) -> str:
        """Индекс в словарь. Всё, что вне диапазона, — пустая строка, а не выдумка."""
        items = vocab[kind]
        if not isinstance(idx, int) or not (0 <= idx < len(items)):
            return ""
        return items[idx]

    steps = {int(s["index"]): s for s in data.get("steps", [])}
    out = []
    for i in range(len(descriptions)):
        s = steps.get(i, {})
        out.append({
            "action": pick("actions", s.get("action_id")),
            "object": pick("objects", s.get("object_id")),
            "tool": pick("tools", s.get("tool_id")),
            "confidence": s.get("confidence"),
        })

    usage = getattr(resp, "usage", None)
    cost = {
        "provider": cfg.llm_provider,
        "model": cfg.structure_model,
        "request_id": getattr(resp, "id", None),
        "input_tokens": getattr(usage, "prompt_tokens", None) if usage else None,
        "output_tokens": getattr(usage, "completion_tokens", None) if usage else None,
    }
    return out, cost
