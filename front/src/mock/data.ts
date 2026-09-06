/* Данные мока — настоящая ручная разметка из hyp0/gt_merged, а не выдуманная.
   Уверенности проставлены здесь: в эталоне их нет, они появляются только у
   модели. Одна намеренно ниже порога, чтобы путь «шаг требует проверки»
   был виден без подгонки. */
import type { Annotation, ClientConfig, Job, Segment, Video } from '../api/types'

export const CONFIG: ClientConfig = {
  min_duration_s: 5,
  max_duration_s: 30,
  min_height: 720,
  accepted_mime: ['video/mp4', 'video/quicktime'],
  max_size_bytes: 200 * 1024 * 1024,
  confidence_threshold: 0.6,
  min_segment_s: 0.4,
  profiles: [
    {
      id: 'contact_phase',
      title: 'Контактные фазы',
      description:
        'Один шаг — одна контактная фаза: подвести руку, взять, переместить, поставить, отпустить.',
    },
    { id: 'coarse', title: 'Крупные шаги', description: 'Обзорная разметка: шаг — законченное действие.' },
  ],
  structure_models: ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5', 'anthropic/claude-opus-5'],
}

type RawSeg = [start: number, end: number, action: string, object: string, confidence: number | null]

const SEGS_00: RawSeg[] = [
  [2.23, 4.40, 'rotate', 'partial toy', 0.88],
  [4.57, 8.53, 'unscrew', 'bucket', 0.51],
  [8.53, 11.07, 'attempt to remove', 'bucket', 0.74],
  [11.07, 13.47, 'attempt to remove', 'bucket', 0.69],
  [13.60, 19.17, 'unscrew', 'arm', 0.92],
]

const SEGS_02: RawSeg[] = [
  [1.27, 3.27, 'tilt up', 'roof', 0.81],
  [3.27, 6.77, 'pull', 'partial toy', 0.9],
  [6.77, 11.60, 'unscrew', 'front body', 0.86],
  [11.60, 13.93, 'put down', 'screw', 0.77],
  [14.03, 20.00, 'unscrew', 'interior', 0.83],
]

export function needsReview(s: Pick<Segment, 'action' | 'object' | 'confidence' | 'start_s' | 'end_s'>): boolean {
  if (!s.action || !s.object) return true
  if (s.end_s - s.start_s < CONFIG.min_segment_s) return true
  return s.confidence !== null && s.confidence < CONFIG.confidence_threshold
}

function buildSegments(raw: RawSeg[]): Segment[] {
  return raw.map(([start_s, end_s, action, object, confidence], index) => {
    const base = {
      index, start_s, end_s, action, object, tool: '', confidence,
      keyframe_ts: +(start_s + (end_s - start_s) * 0.45).toFixed(2),
      edited_by_human: false,
    }
    return { ...base, needs_review: needsReview(base) }
  })
}

const iso = (daysAgo: number, h: number, m: number) => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

export interface MockState {
  videos: Video[]
  jobs: Job[]
  annotations: Annotation[]
  /** Ролики, для которых мок отдаёт настоящий файл из public/mock. */
  localFiles: Record<string, string>
}

export function seed(): MockState {
  const videos: Video[] = [
    {
      video_id: 'v-static-00', filename: 'asm_static_00.mp4', mime: 'video/mp4',
      duration_s: 20, fps: 30, width: 1280, height: 720, size_bytes: 10_190_000,
      created_at: iso(0, 19, 12), latest_annotation_id: 'a-static-00', latest_job_id: 'j-static-00',
    },
    {
      video_id: 'v-static-05', filename: 'asm_static_05.mp4', mime: 'video/mp4',
      duration_s: 24, fps: 30, width: 1280, height: 720, size_bytes: 9_800_000,
      created_at: iso(0, 19, 40), latest_job_id: 'j-static-05',
    },
    {
      video_id: 'v-static-02', filename: 'asm_static_02.mp4', mime: 'video/mp4',
      duration_s: 20, fps: 30, width: 1280, height: 720, size_bytes: 10_188_000,
      created_at: iso(1, 14, 2), latest_annotation_id: 'a-static-02', latest_job_id: 'j-static-02',
    },
    {
      video_id: 'v-ego-11', filename: 'asm_ego_11.mp4', mime: 'video/mp4',
      duration_s: 17, fps: 30, width: 1280, height: 720, size_bytes: 5_045_000,
      created_at: iso(1, 11, 30), latest_job_id: 'j-ego-11',
    },
  ]

  const jobs: Job[] = [
    {
      job_id: 'j-static-00', video_id: 'v-static-00', status: 'succeeded',
      stage: 'persist', stage_index: 6, progress: 1, annotation_id: 'a-static-00',
      model: 'marlin-2b', structure_model: 'anthropic/claude-haiku-4.5',
      created_at: iso(0, 19, 12), finished_at: iso(0, 19, 13),
      timings: { submit: 1.2, infer: 34.8, parse: 0.01, structure: 2.1, postprocess: 0.05, keyframes: 3.4, persist: 0.08 },
    },
    {
      // единственная живая задача: её прогресс двигается во времени
      job_id: 'j-static-05', video_id: 'v-static-05', status: 'running',
      stage: 'infer', stage_index: 1, progress: 0.12, eta_s: 70,
      model: 'marlin-2b', structure_model: 'anthropic/claude-haiku-4.5',
      created_at: new Date().toISOString(), started_at: new Date().toISOString(),
    },
    {
      job_id: 'j-static-02', video_id: 'v-static-02', status: 'succeeded',
      stage: 'persist', stage_index: 6, progress: 1, annotation_id: 'a-static-02',
      model: 'marlin-2b', structure_model: 'anthropic/claude-haiku-4.5',
      created_at: iso(1, 14, 2), finished_at: iso(1, 14, 4),
      timings: { submit: 1.1, infer: 31.2, parse: 0.01, structure: 1.9, postprocess: 0.04, keyframes: 3.1, persist: 0.07 },
    },
    {
      // разбор упал — отдельный код ошибки, не «модель не смогла»
      job_id: 'j-ego-11', video_id: 'v-ego-11', status: 'failed',
      stage: 'parse', stage_index: 2, progress: 0.4,
      model: 'marlin-2b', created_at: iso(1, 11, 30), finished_at: iso(1, 11, 32),
      raw_response_url: '/api/v1/jobs/j-ego-11/raw',
      error: {
        type: 'about:blank', title: 'Разбор ответа модели не удался', status: 422,
        code: 'model_parse_failed',
        detail: 'В ответе модели не нашлось ни одной строки с таймкодами.',
      },
    },
  ]

  const now = new Date().toISOString()
  const annotations: Annotation[] = [
    {
      annotation_id: 'a-static-00', video_id: 'v-static-00', job_id: 'j-static-00',
      duration_s: 20, fps: 2, model: 'marlin-2b+anthropic/claude-haiku-4.5',
      version: 1, segments: buildSegments(SEGS_00),
      created_at: iso(0, 19, 13), updated_at: iso(0, 19, 13),
    },
    {
      annotation_id: 'a-static-02', video_id: 'v-static-02', job_id: 'j-static-02',
      duration_s: 20, fps: 2, model: 'marlin-2b+anthropic/claude-haiku-4.5',
      version: 4,
      segments: buildSegments(SEGS_02).map((s) => ({ ...s, edited_by_human: s.index === 3 })),
      created_at: iso(1, 14, 4), updated_at: now, reviewed_at: iso(1, 15, 10),
    },
  ]

  return {
    videos, jobs, annotations,
    // Настоящие файлы кладёт `npm run seed`. Нет файла — плеер честно
    // показывает заглушку вместо того, чтобы делать вид, что видео есть.
    localFiles: {
      'v-static-00': '/mock/asm_static_00.mp4',
      'v-static-02': '/mock/asm_static_02.mp4',
    },
  }
}
