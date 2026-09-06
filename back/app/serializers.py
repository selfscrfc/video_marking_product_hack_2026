from . import services
from .models import Annotation as AnnotationRow
from .models import Job as JobRow

STAGES = ["submit", "infer", "parse", "structure", "postprocess", "keyframes", "persist"]


def job_out(job: JobRow) -> dict:
    stage_index = STAGES.index(job.stage) if job.stage in STAGES else None
    return {
        "job_id": job.id, "video_id": job.video_id, "status": job.status,
        "stage": job.stage, "stage_index": stage_index, "stages": STAGES,
        "progress": job.progress, "eta_s": None,
        "annotation_id": job.annotation_id,
        "params": job.params or {}, "model": job.model,
        "structure_model": job.structure_model,
        "created_at": job.created_at, "started_at": job.started_at,
        "finished_at": job.finished_at,
        "timings": job.timings or {}, "cost": job.cost or {}, "error": job.error,
        # error — только про провал задачи; частичные сбои в degraded.
        "degraded": job.degraded or [],
        "raw_response_url": f"/api/v1/jobs/{job.id}/raw" if job.raw_path else None,
    }


def annotation_out(ann: AnnotationRow, duration_s: float) -> dict:
    return {
        "annotation_id": ann.id, "video_id": ann.video_id, "job_id": ann.job_id,
        "duration_s": duration_s, "fps": ann.fps, "model": ann.model,
        "version": ann.version,
        "segments": [{
            "index": s.index, "start_s": s.start_s, "end_s": s.end_s,
            "action": s.action, "object": s.object, "tool": s.tool,
            "confidence": s.confidence, "keyframe_ts": s.keyframe_ts,
            "keyframe_url": (
                f"/api/v1/annotations/{ann.id}/segments/{s.index}/keyframe"
                if s.keyframe_ts is not None else None),
            "edited_by_human": s.edited_by_human,
            "needs_review": services.needs_review(s),
        } for s in ann.segments],
        "meta": ann.meta or {},
        # На разметке, а не только на задаче: экран проверки держит разметку и
        # до задачи не дотягивается. В экспорт не идёт — export_dict берёт
        # только канонические поля.
        "degraded": ann.degraded or [],
        "reviewed_at": ann.reviewed_at,
        "created_at": ann.created_at, "updated_at": ann.updated_at,
        "stats": services.stats(ann),
    }
