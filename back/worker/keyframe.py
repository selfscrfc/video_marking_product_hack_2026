"""Выбор ключевого кадра.

Внутри сегмента берём кадр, на котором действие уже началось и ещё не
заканчивается: максимум резкости (дисперсия лапласиана) со штрафом за большое
отличие от соседних кадров. Первое отсекает смазанные кадры, второе —
переходные; отступ от границ убирает кадры стыка.
"""
from __future__ import annotations

import pathlib

MARGIN = 0.10          # отступ от границ шага, доля длительности
MAX_CANDIDATES = 12    # больше не нужно: шаги короткие


def pick(video_path: pathlib.Path, start_s: float, end_s: float) -> float | None:
    import cv2
    import numpy as np

    lo = start_s + (end_s - start_s) * MARGIN
    hi = end_s - (end_s - start_s) * MARGIN
    if hi <= lo:
        return round((start_s + end_s) / 2, 3)

    n = min(MAX_CANDIDATES, max(3, int((hi - lo) * 4)))
    stamps = [lo + (hi - lo) * i / (n - 1) for i in range(n)]

    cap = cv2.VideoCapture(str(video_path))
    try:
        grays, kept = [], []
        for ts in stamps:
            cap.set(cv2.CAP_PROP_POS_MSEC, ts * 1000.0)
            ok, frame = cap.read()
            if not ok:
                continue
            g = cv2.cvtColor(cv2.resize(frame, (320, 180)), cv2.COLOR_BGR2GRAY)
            grays.append(g.astype(np.float32))
            kept.append(ts)
        if not kept:
            return round((start_s + end_s) / 2, 3)

        sharp = np.array([cv2.Laplacian(g, cv2.CV_32F).var() for g in grays])
        sharp = sharp / (sharp.max() or 1.0)

        # отличие от соседей: чем больше, тем «переходнее» кадр
        motion = np.zeros(len(grays), dtype=np.float32)
        for i in range(len(grays)):
            nb = [grays[j] for j in (i - 1, i + 1) if 0 <= j < len(grays)]
            if nb:
                motion[i] = np.mean([np.abs(grays[i] - x).mean() for x in nb])
        motion = motion / (motion.max() or 1.0)

        score = sharp - 0.5 * motion
        return round(float(kept[int(score.argmax())]), 3)
    finally:
        cap.release()
