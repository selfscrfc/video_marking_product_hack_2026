import type { Annotation, Job, Video, VideoState } from './types'

/** Одно состояние строки из трёх источников: видео, задача, разметка.
 *  В API такого поля нет и быть не должно — это представление списка. */
export function videoState(
  _video: Video, job: Job | undefined, annotation: Annotation | undefined,
): VideoState {
  if (job?.status === 'queued' || job?.status === 'running') return 'processing'
  // Разметка важнее упавшей задачи. Ролик, у которого разметка есть, а
  // последний перезапуск не удался, — это ролик с разметкой, а не сломанный:
  // иначе готовая работа прячется за ошибкой повторного прогона.
  if (annotation) return annotation.reviewed_at ? 'done' : 'review'
  if (job?.status === 'failed') return 'failed'
  // Задачи нет вовсе: ролик только что принят и ещё не поставлен в обработку.
  return 'uploading'
}
