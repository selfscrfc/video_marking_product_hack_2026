/* Мок бэкенда. Нужен, чтобы фронт открывался без поднятого стека — работа над
   UI, демонстрация верстки, отладка без docker compose.
   Правило: мок повторяет контракт из spec/openapi.yaml, включая инварианты и
   коды ошибок. Если он будет добрее настоящего сервера, фронт научится жить
   на поблажках и сломается в день интеграции. */
import type { Annotation, Job, Problem, Segment } from '../api/types'
import { CONFIG, needsReview, seed, type MockState } from './data'

// По умолчанию фронт идёт в настоящий API: /api/v1 проксируется на бэкенд
// (см. vite.config.ts). Мок включается явно — VITE_USE_MOCK=1 npm run dev.
export const MOCK_ENABLED =
  (import.meta as { env?: Record<string, string> }).env?.VITE_USE_MOCK === '1'

const state: MockState = seed()
const LATENCY_MS = 140

/** Ссылка на настоящий файл ролика, если он положен в public/mock. */
export function mockMediaUrl(videoId: string): string | null {
  return state.localFiles[videoId] ?? null
}

const problem = (status: number, code: Problem['code'], title: string, detail?: string): Response =>
  new Response(JSON.stringify({ type: 'about:blank', status, code, title, detail }), {
    status, headers: { 'content-type': 'application/problem+json' },
  })

const ok = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200, ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

/* ——— доменные правила, те же, что заявлены у сервера ——— */

/** Порядок задаёт время, а не массив: после правки границы номера меняются. */
function normalize(segments: Segment[]): Segment[] {
  return [...segments]
    .sort((a, b) => a.start_s - b.start_s)
    .map((s, index) => ({ ...s, index, needs_review: needsReview(s) }))
}

function validate(segments: Segment[], duration: number): Response | null {
  for (const s of segments) {
    if (s.end_s <= s.start_s) {
      return problem(422, 'segment_inverted', 'Конец шага не позже начала',
        `Шаг ${s.index}: ${s.start_s.toFixed(2)}–${s.end_s.toFixed(2)} с.`)
    }
    if (s.start_s < 0 || s.end_s > duration + 1e-6) {
      return problem(422, 'segment_out_of_bounds', 'Шаг выходит за пределы ролика',
        `Шаг ${s.index} не помещается в 0–${duration.toFixed(1)} с.`)
    }
  }
  const sorted = normalize(segments)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!, cur = sorted[i]!
    if (cur.start_s < prev.end_s - 1e-6) {
      return problem(422, 'segment_overlap', 'Границы шагов пересекаются',
        `Шаг ${prev.index} (${prev.start_s.toFixed(1)}–${prev.end_s.toFixed(1)} с) ` +
        `заходит на шаг ${cur.index} (${cur.start_s.toFixed(1)}–${cur.end_s.toFixed(1)} с).`)
    }
  }
  return null
}

function commit(ann: Annotation, segments: Segment[]): Response {
  const bad = validate(segments, ann.duration_s)
  if (bad) return bad
  ann.segments = normalize(segments)
  ann.version += 1
  ann.updated_at = new Date().toISOString()
  return ok(withStats(ann), { headers: { etag: `"${ann.version}"` } })
}

function withStats(ann: Annotation): Annotation {
  const segs = ann.segments
  const total = segs.reduce((acc, s) => acc + (s.end_s - s.start_s), 0)
  return {
    ...ann,
    stats: {
      segment_count: segs.length,
      edited_count: segs.filter((s) => s.edited_by_human).length,
      needs_review_count: segs.filter((s) => s.needs_review).length,
      mean_segment_s: segs.length ? +(total / segs.length).toFixed(2) : 0,
    },
  }
}

function checkVersion(req: Request, ann: Annotation): Response | null {
  const header = req.headers.get('if-match')
  if (!header) {
    return problem(428, 'version_missing', 'Не передана версия разметки',
      'Правка требует заголовка If-Match со значением из ETag.')
  }
  if (header.replace(/"/g, '') !== String(ann.version)) {
    return problem(409, 'version_conflict', 'Разметку успели изменить',
      'Перечитайте разметку: ваша версия устарела.')
  }
  return null
}

/* ——— живая задача: прогресс двигается сам, чтобы экран обработки был настоящим ——— */

const STAGES = ['submit', 'infer', 'parse', 'structure', 'postprocess', 'keyframes', 'persist'] as const
const RUN_SECONDS = 50
const startedAt = Date.now()

function advanceJobs(): void {
  for (const job of state.jobs) {
    if (job.status !== 'running') continue
    const elapsed = (Date.now() - startedAt) / 1000
    const p = Math.min(1, elapsed / RUN_SECONDS)
    job.progress = +p.toFixed(3)
    job.eta_s = Math.max(0, Math.round(RUN_SECONDS - elapsed))
    // infer занимает основную часть — так же, как в timings настоящего прогона
    job.stage_index = p < 0.08 ? 0 : p < 0.72 ? 1 : p < 0.76 ? 2 : p < 0.86 ? 3 : p < 0.9 ? 4 : p < 0.98 ? 5 : 6
    job.stage = STAGES[job.stage_index]
    job.stages = [...STAGES]
    if (p >= 1) {
      job.status = 'succeeded'
      job.finished_at = new Date().toISOString()
      job.eta_s = 0
      const ann = finishJob(job)
      job.annotation_id = ann.annotation_id
    }
  }
}

/** Результат живой задачи: та же форма, что у остальных, но своя разметка. */
function finishJob(job: Job): Annotation {
  const video = state.videos.find((v) => v.video_id === job.video_id)!
  const raw: [number, number, string, string, number][] = [
    [0.0, 5.1, 'pick up', 'screwdriver', 0.79],
    [5.1, 12.4, 'unscrew', 'front body', 0.64],
    [12.4, 18.2, 'put down', 'screwdriver', 0.44],
    [18.2, video.duration_s, 'rotate', '', 0.38],
  ]
  const segments = normalize(raw.map(([start_s, end_s, action, object, confidence], index) => ({
    index, start_s, end_s, action, object, tool: '', confidence,
    keyframe_ts: +(start_s + (end_s - start_s) * 0.45).toFixed(2),
    edited_by_human: false, needs_review: false,
  })))
  const ann: Annotation = {
    annotation_id: `a-${job.video_id}`, video_id: job.video_id, job_id: job.job_id,
    duration_s: video.duration_s, fps: 2, model: 'marlin-2b+Qwen/Qwen3-4B-Instruct-2507',
    version: 1, segments,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
  state.annotations.push(ann)
  video.latest_annotation_id = ann.annotation_id
  return ann
}

/* ——— маршрутизация ——— */

async function route(req: Request, url: URL): Promise<Response> {
  advanceJobs()
  const p = url.pathname.replace(/^\/api\/v1/, '')
  const seg = p.split('/').filter(Boolean)
  const m = req.method.toUpperCase()

  if (p === '/config') return ok(CONFIG)
  if (p === '/health') return ok({ ready: true, version: 'mock', database: true, queue: true })

  if (p === '/videos' && m === 'GET') {
    return ok({ items: state.videos, total: state.videos.length })
  }

  if (seg[0] === 'videos' && seg[1]) {
    const video = state.videos.find((v) => v.video_id === seg[1])
    if (!video) return problem(404, 'video_not_found', 'Ролик не найден')

    if (seg.length === 2 && m === 'GET') return ok(video)
    if (seg.length === 2 && m === 'DELETE') {
      state.videos = state.videos.filter((v) => v.video_id !== video.video_id)
      return new Response(null, { status: 204 })
    }
    if (seg[2] === 'annotation' && m === 'GET') {
      const ann = state.annotations.find((a) => a.annotation_id === video.latest_annotation_id)
      return ann ? ok(withStats(ann), { headers: { etag: `"${ann.version}"` } })
        : problem(404, 'annotation_not_found', 'Разметки для этого ролика ещё нет')
    }
    if (seg[2] === 'jobs' && m === 'POST') {
      const job: Job = {
        job_id: `j-${Date.now()}`, video_id: video.video_id, status: 'queued',
        stage: 'submit', stage_index: 0, progress: 0, model: 'marlin-2b',
        structure_model: CONFIG.structure_models[0], created_at: new Date().toISOString(),
      }
      state.jobs.push(job)
      video.latest_job_id = job.job_id
      return ok(job, { status: 202, headers: { location: `/api/v1/jobs/${job.job_id}` } })
    }
  }

  if (seg[0] === 'jobs' && seg[1]) {
    const job = state.jobs.find((j) => j.job_id === seg[1])
    if (!job) return problem(404, 'job_not_found', 'Задача не найдена')
    if (seg.length === 2 && m === 'GET') return ok(job)
    if (seg[2] === 'cancel' && m === 'POST') {
      if (job.status === 'succeeded' || job.status === 'failed') {
        return problem(409, 'job_not_cancellable', 'Задача уже завершилась')
      }
      job.status = 'cancelled'
      return ok(job, { status: 202 })
    }
    if (seg[2] === 'raw' && m === 'GET') {
      return new Response(
        'Scene: a person disassembles a toy on a table.\n\nno timestamped events found\n',
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      )
    }
  }

  if (seg[0] === 'annotations' && seg[1]) {
    const ann = state.annotations.find((a) => a.annotation_id === seg[1])
    if (!ann) return problem(404, 'annotation_not_found', 'Разметка не найдена')

    if (seg.length === 2 && m === 'GET') {
      return ok(withStats(ann), { headers: { etag: `"${ann.version}"` } })
    }

    if (seg[2] === 'review') {
      const conflict = checkVersion(req, ann)
      if (conflict) return conflict
      if (m === 'POST') {
        if (!ann.segments.length) {
          return problem(422, 'annotation_empty', 'Завершать нечего',
            'В разметке нет ни одного шага.')
        }
        ann.reviewed_at = new Date().toISOString()
      } else if (m === 'DELETE') {
        ann.reviewed_at = null
      }
      ann.version += 1
      ann.updated_at = new Date().toISOString()
      return ok(withStats(ann), { headers: { etag: `"${ann.version}"` } })
    }

    if (seg[2] === 'export' && m === 'GET') {
      const format = url.searchParams.get('format')
      if (!ann.segments.length) {
        return problem(422, 'annotation_empty', 'Выгружать нечего',
          'В разметке нет ни одного шага.')
      }
      const video = state.videos.find((v) => v.video_id === ann.video_id)!
      const stem = video.filename.replace(/\.[^.]+$/, '')
      const body = format === 'csv' ? toCsv(ann, stem) : toJson(ann, stem)
      return new Response(body, {
        headers: {
          'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
          'content-disposition': `attachment; filename="${stem}.${format}"`,
        },
      })
    }

    if (seg[2] === 'segments') {
      const conflict = m === 'GET' ? null : checkVersion(req, ann)
      if (conflict) return conflict

      if (seg.length === 3 && m === 'POST') {
        const body = await req.json() as { start_s: number; end_s: number }
        const next: Segment = {
          index: ann.segments.length, start_s: body.start_s, end_s: body.end_s,
          action: '', object: '', tool: '', confidence: null,
          keyframe_ts: +((body.start_s + body.end_s) / 2).toFixed(2),
          edited_by_human: true, needs_review: true,
        }
        return commit(ann, [...ann.segments, next])
      }

      // Пакетная правка: индексы — нумерация ДО применения, поэтому шаги
      // находятся заранее и только потом меняются. Порядок правок не важен.
      if (seg.length === 3 && m === 'PATCH') {
        const body = await req.json() as { edits: { index: number; patch: Partial<Segment> }[] }
        if (!body.edits?.length) {
          return problem(422, 'validation_failed', 'Пустой список правок')
        }
        const seen = new Set<number>()
        for (const e of body.edits) {
          if (seen.has(e.index)) {
            return problem(422, 'validation_failed', 'Шаг правится дважды',
              `индекс ${e.index} встречается в списке больше одного раза`)
          }
          seen.add(e.index)
          if (!ann.segments.some((s) => s.index === e.index)) {
            return problem(404, 'segment_not_found', 'Шаг не найден')
          }
        }
        const byIndex = new Map(body.edits.map((e) => [e.index, e.patch]))
        return commit(ann, ann.segments.map((s) => {
          const patch = byIndex.get(s.index)
          return patch ? { ...s, ...patch, edited_by_human: true } : s
        }))
      }

      const index = Number(seg[3])
      const target = ann.segments.find((s) => s.index === index)
      if (!target) return problem(404, 'segment_not_found', 'Шаг не найден')

      if (seg.length === 4 && m === 'PATCH') {
        const patch = await req.json() as Partial<Segment>
        const updated = { ...target, ...patch, edited_by_human: true }
        return commit(ann, ann.segments.map((s) => (s.index === index ? updated : s)))
      }
      if (seg.length === 4 && m === 'DELETE') {
        return commit(ann, ann.segments.filter((s) => s.index !== index))
      }
      if (seg[4] === 'split' && m === 'POST') {
        const { at_s } = await req.json() as { at_s: number }
        if (at_s <= target.start_s || at_s >= target.end_s) {
          return problem(422, 'segment_out_of_bounds', 'Точка разреза вне шага')
        }
        const left = { ...target, end_s: at_s, edited_by_human: true }
        const right = { ...target, start_s: at_s, edited_by_human: true, keyframe_ts: null }
        return commit(ann, [...ann.segments.filter((s) => s.index !== index), left, right])
      }
      if (seg[4] === 'merge' && m === 'POST') {
        const { with: side } = await req.json() as { with: 'prev' | 'next' }
        const other = ann.segments.find((s) => s.index === index + (side === 'next' ? 1 : -1))
        if (!other) return problem(422, 'segment_not_found', 'Соседнего шага нет')
        const merged: Segment = {
          ...target,
          start_s: Math.min(target.start_s, other.start_s),
          end_s: Math.max(target.end_s, other.end_s),
          edited_by_human: true,
        }
        return commit(ann, [
          ...ann.segments.filter((s) => s.index !== index && s.index !== other.index), merged,
        ])
      }
      if (seg[4] === 'suggestions') {
        // В первой версии контракта метод объявлен, но не реализован —
        // мок повторяет это, а не изображает готовую функцию.
        return problem(501, 'not_implemented', 'Подсказки появятся во второй версии')
      }
    }
  }

  return problem(404, 'service_unavailable', 'Метод не найден в моке', p)
}

/* ——— экспорт: ровно канонический формат из spec/annotation.schema.json ——— */

export function exportBody(ann: Annotation, videoId: string) {
  return {
    video_id: videoId,
    duration_s: ann.duration_s,
    segments: ann.segments.map((s) => ({
      start_s: +s.start_s.toFixed(3), end_s: +s.end_s.toFixed(3),
      action: s.action, object: s.object, tool: s.tool,
      confidence: s.confidence, keyframe_ts: s.keyframe_ts,
      edited_by_human: s.edited_by_human,
    })),
    fps: ann.fps ?? null,
    model: ann.model ?? '',
    meta: ann.meta ?? {},
  }
}

const toJson = (ann: Annotation, videoId: string) =>
  JSON.stringify(exportBody(ann, videoId), null, 2)

export function toCsv(ann: Annotation, videoId: string): string {
  const head = ['video_id', 'segment_index', 'start_s', 'end_s', 'action', 'object',
    'tool', 'confidence', 'keyframe_ts', 'edited_by_human']
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const num = (v: number | null) => (v === null ? '' : v.toFixed(3))
  const rows = ann.segments.map((s) => [
    videoId, String(s.index), s.start_s.toFixed(3), s.end_s.toFixed(3),
    esc(s.action), esc(s.object), esc(s.tool),
    num(s.confidence), num(s.keyframe_ts), String(s.edited_by_human),
  ].join(','))
  return [head.join(','), ...rows].join('\n') + '\n'
}

/* ——— установка перехватчиков ——— */

export function installMock(): void {
  if (!MOCK_ENABLED) return

  const realFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init)
    const url = new URL(req.url, location.origin)
    if (!url.pathname.startsWith('/api/v1')) return realFetch(input as RequestInfo, init)
    await new Promise((r) => setTimeout(r, LATENCY_MS))
    return route(req, url)
  }

  // Загрузка идёт через XHR — ради прогресса, которого fetch не отдаёт.
  // Поэтому мок подменяет и его, но только для POST /videos.
  const RealXHR = window.XMLHttpRequest
  class MockXHR extends RealXHR {
    private mockUrl = ''
    override open(method: string, url: string | URL, ...rest: unknown[]): void {
      this.mockUrl = String(url)
      if (this.isUpload()) return
      // @ts-expect-error проброс переменной сигнатуры
      super.open(method, url, ...rest)
    }
    override send(body?: Document | XMLHttpRequestBodyInit | null): void {
      if (!this.isUpload()) return super.send(body)
      const file = (body as FormData).get('file') as File
      simulateUpload(this, file)
    }
    private isUpload() { return this.mockUrl.endsWith('/api/v1/videos') }
  }
  window.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest
}

function simulateUpload(xhr: XMLHttpRequest, file: File): void {
  const total = file.size || 1
  let loaded = 0
  const step = () => {
    loaded = Math.min(total, loaded + total / 12)
    xhr.upload.dispatchEvent(
      Object.assign(new ProgressEvent('progress'), { lengthComputable: true, loaded, total }),
    )
    if (loaded < total) return void setTimeout(step, 180)

    const video = {
      video_id: `v-${Date.now()}`, filename: file.name, mime: file.type || 'video/mp4',
      duration_s: 18, fps: 30, width: 1280, height: 720, size_bytes: file.size,
      created_at: new Date().toISOString(),
    }
    state.videos.unshift(video)
    Object.defineProperty(xhr, 'status', { value: 201, configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: JSON.stringify(video), configurable: true })
    xhr.dispatchEvent(new Event('load'))
  }
  setTimeout(step, 180)
}
