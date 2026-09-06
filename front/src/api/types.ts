/* Типы — зеркало spec/openapi.yaml. Если контракт меняется, правится и здесь. */

export type ErrorCode =
  | 'video_format_unsupported' | 'video_duration_out_of_range' | 'video_resolution_too_low'
  | 'video_too_large' | 'video_unreadable' | 'video_not_found'
  | 'job_not_found' | 'job_not_cancellable'
  | 'inference_failed' | 'model_parse_failed' | 'structure_failed'
  | 'annotation_not_found' | 'annotation_empty'
  | 'segment_not_found' | 'segment_overlap' | 'segment_inverted' | 'segment_out_of_bounds'
  | 'version_missing' | 'version_conflict'
  // Прилетает на любое нарушение схемы запроса, то есть чаще всех остальных.
  | 'validation_failed'
  | 'export_schema_invalid' | 'not_implemented' | 'service_unavailable'

export interface Problem {
  type: string
  title: string
  status: number
  code: ErrorCode
  detail?: string
  errors?: { pointer: string; message: string }[]
}

export interface GranularityProfile {
  id: 'contact_phase' | 'coarse'
  title: string
  description?: string
}

export interface ClientConfig {
  min_duration_s: number
  max_duration_s: number
  min_height: number
  accepted_mime: string[]
  max_size_bytes: number
  confidence_threshold: number
  min_segment_s: number
  profiles: GranularityProfile[]
  structure_models: string[]
}

export interface Video {
  video_id: string
  filename: string
  mime?: string
  duration_s: number
  fps?: number
  width: number
  height: number
  size_bytes?: number
  sha256?: string
  created_at: string
  latest_annotation_id?: string | null
  latest_job_id?: string | null
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type JobStage =
  | 'submit' | 'infer' | 'parse' | 'structure' | 'postprocess' | 'keyframes' | 'persist'

export const STAGE_TITLES: Record<JobStage, string> = {
  submit: 'Отправка на GPU',
  infer: 'Модель смотрит ролик',
  parse: 'Разбор ответа',
  structure: 'Действие и объект',
  postprocess: 'Постобработка',
  keyframes: 'Ключевые кадры',
  persist: 'Сохранение',
}

export interface Job {
  job_id: string
  video_id: string
  status: JobStatus
  stage?: JobStage
  stage_index?: number
  stages?: JobStage[]
  progress?: number
  eta_s?: number | null
  annotation_id?: string | null
  model?: string
  structure_model?: string
  created_at: string
  started_at?: string | null
  finished_at?: string | null
  timings?: Record<string, number>
  cost?: unknown
  /** Непусто ровно тогда, когда status === 'failed'. Частичные сбои — в degraded. */
  error?: Problem
  degraded?: Degradation[]
  raw_response_url?: string | null
}

export interface Segment {
  index: number
  start_s: number
  end_s: number
  action: string
  object: string
  tool: string
  confidence: number | null
  keyframe_ts: number | null
  keyframe_url?: string | null
  edited_by_human: boolean
  needs_review: boolean
}

export interface AnnotationStats {
  segment_count: number
  edited_count: number
  needs_review_count: number
  mean_segment_s: number
}

export interface Annotation {
  annotation_id: string
  video_id: string
  job_id?: string | null
  duration_s: number
  fps?: number | null
  model?: string
  version: number
  segments: Segment[]
  meta?: Record<string, unknown>
  /** Стадии, не отработавшие при построении этой разметки. Пусто — всё сошлось. */
  degraded?: Degradation[]
  /** Когда человек нажал «Завершить разметку». null — ролик ещё ждёт проверки. */
  reviewed_at?: string | null
  created_at: string
  updated_at: string
  stats?: AnnotationStats
}

/** Правка сегмента. Ровно те поля, что принимает PATCH: index, needs_review и
 *  edited_by_human производные — сервер их считает сам. */
export interface SegmentPatch {
  start_s?: number
  end_s?: number
  action?: string
  object?: string
  tool?: string
  keyframe_ts?: number
}

/** Стадия, которая не отработала, не уронив задачу. Разметка при этом есть, но
 *  неполная — пустой список означает здоровую. */
export interface Degradation {
  stage: string
  code: ErrorCode
  title: string
  detail?: string
  /** Чем это грозит разметчику. Текст приходит с сервера, чтобы формулировка
   *  была одна на всех экранах, где эту разметку показывают. */
  impact: string
}

/** Одна правка в пакете. `index` — нумерация ДО применения: сервер находит все
 *  шаги заранее и только потом меняет, поэтому порядок правок не важен. */
export interface SegmentEdit {
  index: number
  patch: SegmentPatch
}

export interface Suggestion {
  action: string
  object: string
  tool?: string
  confidence?: number | null
  source?: 'resample' | 'sibling'
}

/* ——— состояние видео в интерфейсе ———
   В API его нет: там отдельно видео, отдельно задача, отдельно разметка.
   Экран списка показывает одну строку на ролик, поэтому три источника
   сворачиваются в одно перечисление здесь, на клиенте. */
export type VideoState =
  | 'uploading' | 'processing' | 'review' | 'done' | 'failed'

export const STATE_TITLES: Record<VideoState, string> = {
  uploading: 'Загружается',
  processing: 'Обрабатывается',
  review: 'Ожидает проверки',
  done: 'Успешная разметка',
  failed: 'Ошибка',
}
