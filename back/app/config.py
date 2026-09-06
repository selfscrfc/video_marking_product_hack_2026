from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://sirochek:sirochek@localhost:5432/sirochek"
    redis_url: str = "redis://localhost:6379/0"
    media_root: str = "/data"
    cors_origins: str = "http://localhost:5173"

    # Modal: там живёт Marlin-2B
    # Провайдеры инференса в порядке предпочтения. Первый рабочий отвечает.
    # local — модель на хосте (Docker на macOS не пробрасывает MPS, поэтому
    # она вне контейнера); modal — облако.
    inference_providers: str = "local,modal"

    # Хост со стороны контейнера. Сервис обязан слушать 0.0.0.0, а не loopback:
    # на loopback контейнер не достучится.
    local_inference_url: str = "http://host.docker.internal:8100"

    modal_token_id: str = ""
    modal_token_secret: str = ""
    modal_app_name: str = "sirochek-marlin"
    modal_function_timeout_s: int = 180

    # Языковая модель для стадии structure. Провайдер — параметр, а не имя в
    # коде: за сессию мы сменили его дважды, и оба раза это должно было быть
    # правкой конфигурации. Годится любой OpenAI-совместимый эндпоинт.
    llm_provider: str = "groq"
    llm_base_url: str = "https://api.groq.com/openai/v1"
    llm_api_key: str = ""
    # Имя сверить с каталогом провайдера (GET {LLM_BASE_URL}/models) до первого
    # прогона: у Groq свой набор, и поддержка json_schema есть не у всех моделей.
    structure_model: str = "openai/gpt-oss-120b"
    # Язык описаний: source — как ответила Marlin (она отвечает по-английски),
    # ru / en — принудительно. Влияет на сверку с эталоном: Assembly101
    # размечен по-английски, а промпт гипотезы 0 просит русский.
    structure_lang: str = "en"

    marlin_fps: float = 2.0
    marlin_max_new_tokens: int = 512
    marlin_prompt_mode: str = "caption"

    min_duration_s: float = 5
    max_duration_s: float = 30
    min_height: int = 720
    max_upload_bytes: int = 209_715_200

    confidence_threshold: float = 0.6
    min_segment_s: float = 0.4
    merge_threshold: float = 0.9

    schema_path: str = "/srv/spec/annotation.schema.json"


@lru_cache
def settings() -> Settings:
    return Settings()
