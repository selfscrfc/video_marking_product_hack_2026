import type {
  Annotation, ClientConfig, Job, Problem, SegmentEdit, SegmentPatch, Suggestion, Video,
} from './types'

const BASE = '/api/v1'

export class ApiError extends Error {
  constructor(readonly problem: Problem, readonly httpStatus: number) {
    super(problem.detail || problem.title)
    this.name = 'ApiError'
  }
  get code() { return this.problem.code }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init)
  if (!res.ok) {
    let problem: Problem = {
      type: 'about:blank', title: res.statusText, status: res.status,
      code: 'service_unavailable',
    }
    try { problem = { ...problem, ...(await res.json()) } } catch { /* тело не json */ }
    throw new ApiError(problem, res.status)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

const json = (body: unknown, version?: number): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
  },
  body: JSON.stringify(body),
})

const withMethod = (init: RequestInit, method: string): RequestInit => ({ ...init, method })

export const api = {
  config: () => request<ClientConfig>('/config'),

  listVideos: () => request<{ items: Video[]; total: number }>('/videos'),
  getVideo: (id: string) => request<Video>(`/videos/${id}`),
  deleteVideo: (id: string) => request<void>(`/videos/${id}`, { method: 'DELETE' }),

  /** Загрузка с прогрессом: fetch его не отдаёт, поэтому XHR. */
  /** Возвращает и признак `existed`: сервер дедуплицирует по sha256 и на
   *  повторную загрузку того же содержимого отвечает 200 с уже имеющимся
   *  роликом вместо 201 с новым. Без этого признака повтор выглядит как
   *  успешная загрузка, после которой в списке ничего не прибавилось. */
  uploadVideo(file: File, onProgress?: (fraction: number) => void):
  Promise<{ video: Video; existed: boolean }> {
    return new Promise((resolve, reject) => {
      const form = new FormData()
      form.append('file', file)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${BASE}/videos`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total)
      }
      xhr.onload = () => {
        let body: unknown
        try { body = JSON.parse(xhr.responseText) } catch { body = null }
        if (xhr.status >= 200 && xhr.status < 300) {
          return resolve({ video: body as Video, existed: xhr.status === 200 })
        }
        reject(new ApiError(
          (body as Problem) ?? {
            type: 'about:blank', title: 'Ошибка загрузки', status: xhr.status,
            code: 'service_unavailable',
          },
          xhr.status,
        ))
      }
      xhr.onerror = () => reject(new ApiError({
        type: 'about:blank', title: 'Сеть недоступна', status: 0, code: 'service_unavailable',
      }, 0))
      xhr.send(form)
    })
  },

  videoContentUrl: (id: string) => `${BASE}/videos/${id}/content`,
  frameUrl: (id: string, at: number, width = 320) =>
    `${BASE}/videos/${id}/frame?ts=${at.toFixed(3)}&w=${width}`,

  /** Без `force` сервер идемпотентен: на те же параметры вернёт ту же задачу,
   *  в том числе упавшую, с кодом 200. Для повтора это тупик — экран не
   *  изменится, — поэтому явный перезапуск всегда идёт с `force`. */
  createJob: (videoId: string, body: Record<string, unknown> = {}) =>
    request<Job>(`/videos/${videoId}/jobs`, json(body)),
  retryJob: (videoId: string) =>
    request<Job>(`/videos/${videoId}/jobs`, json({ force: true })),
  getJob: (id: string) => request<Job>(`/jobs/${id}`),
  cancelJob: (id: string) => request<Job>(`/jobs/${id}/cancel`, { method: 'POST' }),
  jobRawUrl: (id: string) => `${BASE}/jobs/${id}/raw`,

  getAnnotation: (id: string) => request<Annotation>(`/annotations/${id}`),
  getVideoAnnotation: (videoId: string) =>
    request<Annotation>(`/videos/${videoId}/annotation`),

  patchSegment: (id: string, index: number, patch: SegmentPatch, version: number) =>
    request<Annotation>(
      `/annotations/${id}/segments/${index}`,
      withMethod(json(patch, version), 'PATCH'),
    ),

  /** Несколько правок одной транзакцией — протяжка границы двигает и сам шаг, и
   *  поджатого соседа. Одна версия на всё: разметка не может остаться
   *  наполовину правленной, если запрос не дойдёт. */
  patchSegments: (id: string, edits: SegmentEdit[], version: number) =>
    request<Annotation>(
      `/annotations/${id}/segments`,
      withMethod(json({ edits }, version), 'PATCH'),
    ),
  addSegment: (id: string, body: { start_s: number; end_s: number }, version: number) =>
    request<Annotation>(`/annotations/${id}/segments`, json(body, version)),
  deleteSegment: (id: string, index: number, version: number) =>
    request<Annotation>(`/annotations/${id}/segments/${index}`, {
      method: 'DELETE', headers: { 'if-match': `"${version}"` },
    }),
  splitSegment: (id: string, index: number, atS: number, version: number) =>
    request<Annotation>(`/annotations/${id}/segments/${index}/split`, json({ at_s: atS }, version)),
  mergeSegment: (id: string, index: number, side: 'prev' | 'next', version: number) =>
    request<Annotation>(`/annotations/${id}/segments/${index}/merge`, json({ with: side }, version)),

  review: (id: string, version: number) =>
    request<Annotation>(`/annotations/${id}/review`, json({}, version)),
  unreview: (id: string, version: number) =>
    request<Annotation>(`/annotations/${id}/review`, {
      method: 'DELETE', headers: { 'if-match': `"${version}"` },
    }),

  suggestions: (id: string, index: number, n = 3) =>
    request<{ items: Suggestion[] }>(
      `/annotations/${id}/segments/${index}/suggestions`, json({ n }),
    ),

  exportUrl: (id: string, format: 'json' | 'csv') =>
    `${BASE}/annotations/${id}/export?format=${format}`,
}
