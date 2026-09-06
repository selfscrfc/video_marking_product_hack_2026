import { useCallback, useEffect, useState } from 'react'
import { ApiError, api } from '../api/client'
import type { Annotation, SegmentEdit, SegmentPatch } from '../api/types'

/** Разметка плюс все правки над ней.
 *  Версию храним из тела ответа и шлём обратно в If-Match: сервер отвечает 409,
 *  если разметку успели изменить, и тогда единственное честное действие —
 *  перечитать, а не повторить запрос. */
export function useAnnotation(annotationId: string | null | undefined) {
  const [annotation, setAnnotation] = useState<Annotation | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(Boolean(annotationId))

  const reload = useCallback(async () => {
    if (!annotationId) return
    setLoading(true)
    try {
      setAnnotation(await api.getAnnotation(annotationId))
      setError(null)
    } catch (e) {
      if (e instanceof ApiError) setError(e)
    } finally {
      setLoading(false)
    }
  }, [annotationId])

  useEffect(() => { void reload() }, [reload])

  /** Возвращает разметку после правки или null, если правка не прошла:
   *  по этому экран проверки понимает, что пора уступить место готовой
   *  разметке, и наоборот. */
  const run = useCallback(async (
    fn: (id: string, version: number) => Promise<Annotation>,
  ): Promise<Annotation | null> => {
    if (!annotation) return null
    setBusy(true)
    try {
      const next = await fn(annotation.annotation_id, annotation.version)
      setAnnotation(next)
      setError(null)
      return next
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e)
        // Кто-то изменил разметку параллельно: молча повторять нельзя —
        // затрём чужую правку. Перечитываем и показываем ошибку.
        if (e.code === 'version_conflict') await reload()
      }
      return null
    } finally {
      setBusy(false)
    }
  }, [annotation, reload])

  return {
    annotation, error, busy, loading, reload,
    clearError: () => setError(null),
    patchSegment: (index: number, patch: SegmentPatch) =>
      run((id, v) => api.patchSegment(id, index, patch, v)),
    /** Несколько правок одним действием — например, протяжка границы, которая
     *  поджала соседний шаг. Один запрос и одна версия: раньше правки шли по
     *  очереди, и сбой на второй оставлял разметку с дырой или нахлёстом ровно
     *  там, где пользователь только что провёл мышью. */
    patchSegments: (edits: SegmentEdit[]) =>
      run((id, v) => api.patchSegments(id, edits, v)),
    addSegment: (start_s: number, end_s: number) =>
      run((id, v) => api.addSegment(id, { start_s, end_s }, v)),
    deleteSegment: (index: number) => run((id, v) => api.deleteSegment(id, index, v)),
    splitSegment: (index: number, atS: number) => run((id, v) => api.splitSegment(id, index, atS, v)),
    mergeSegment: (index: number, side: 'prev' | 'next') =>
      run((id, v) => api.mergeSegment(id, index, side, v)),
    review: () => run((id, v) => api.review(id, v)),
    unreview: () => run((id, v) => api.unreview(id, v)),
  }
}
