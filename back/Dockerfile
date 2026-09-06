FROM python:3.12-slim

# ffprobe — метаданные ролика на загрузке; ffmpeg тянет и кодеки для OpenCV
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY back/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY back/app ./app
COPY back/worker ./worker
# Схема экспорта живёт в одном экземпляре: сервер валидирует ею выгрузку и её же
# отдаёт наружу по GET /schema/annotation.json.
COPY spec/annotation.schema.json ./spec/annotation.schema.json

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
