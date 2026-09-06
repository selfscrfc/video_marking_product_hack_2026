"""Метаданные ролика и извлечение кадров."""
import json
import pathlib
import subprocess

from .errors import ApiError


def probe(path: pathlib.Path) -> dict:
    """ffprobe: длительность, разрешение, частота, кодек."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, check=True).stdout
        data = json.loads(out)
    except Exception as e:  # noqa: BLE001
        raise ApiError(422, "video_unreadable", "Не удалось прочитать файл",
                       f"ffprobe: {e}") from e

    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if not video:
        raise ApiError(415, "video_format_unsupported", "В файле нет видеодорожки")

    fps = None
    if video.get("avg_frame_rate", "0/0") not in ("0/0", ""):
        num, _, den = video["avg_frame_rate"].partition("/")
        if float(den or 1):
            fps = round(float(num) / float(den or 1), 3)

    return {
        "duration_s": float(data["format"]["duration"]),
        "width": int(video["width"]),
        "height": int(video["height"]),
        "fps": fps,
        "codec": video.get("codec_name", ""),
    }


def extract_frame(video_path: pathlib.Path, ts: float, width: int, out: pathlib.Path) -> None:
    import cv2

    cap = cv2.VideoCapture(str(video_path))
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, max(ts, 0) * 1000.0)
        ok, frame = cap.read()
        if not ok:
            raise ApiError(422, "video_unreadable", "Кадр не читается",
                           f"таймкод {ts} с")
        h, w = frame.shape[:2]
        if width and width < w:
            frame = cv2.resize(frame, (width, max(1, round(h * width / w))),
                               interpolation=cv2.INTER_AREA)
        out.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out), frame, [cv2.IMWRITE_JPEG_QUALITY, 88])
    finally:
        cap.release()
