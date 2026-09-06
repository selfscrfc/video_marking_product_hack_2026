import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { pct } from '../api/format'
import { STAGE_TITLES, type Job, type Video } from '../api/types'
import { Keyframe } from '../components/Keyframe'

export function ProcessingPage({ video, job: initial, onFinished }: {
  video: Video
  job: Job
  /** Обработка закончилась — маршрут по готовой задаче откроет разметку. */
  onFinished: (job: Job) => void
}) {
  const navigate = useNavigate()
  const [job, setJob] = useState(initial)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    if (job.status !== 'queued' && job.status !== 'running') return
    const id = setInterval(() => {
      void api.getJob(job.job_id).then(setJob).catch(() => {})
    }, 1500)
    return () => clearInterval(id)
  }, [job.job_id, job.status])

  /* Раньше здесь был navigate на тот же адрес. Он ничего не делал: маршрут
     тот же, параметры те же, компонент не перемонтируется — и экран оставался
     на обработке уже готового ролика. Отдаём задачу наверх, там по ней
     подтянется разметка и откроется экран проверки. */
  useEffect(() => {
    if (job.status === 'succeeded') onFinished(job)
  }, [job, onFinished])

  const stages = job.stages ?? []
  const failed = job.status === 'failed'

  return (
    <div className="screen screen--center">
      <div className="processing">
        <Keyframe
          videoId={video.video_id} at={video.duration_s / 2} width={560}
          className="processing__preview" placeholder="превью кадра"
        />

        <div className="processing__head">
          <span className="display processing__title">
            {failed ? 'Обработка не удалась' : 'Модель анализирует видео'}
          </span>
          <p className="processing__note">
            {failed
              ? job.error?.detail ?? 'Подробностей нет.'
              : 'Определяются интервалы, действия, объекты и ключевые кадры. '
                + 'Экран можно закрыть — обработка продолжится.'}
          </p>
        </div>

        {!failed && (
          <div className="processing__progress">
            <div className="processing__row">
              <span>{job.stage ? STAGE_TITLES[job.stage] : 'В очереди'}</span>
              <span>{pct(job.progress ?? 0)}</span>
            </div>
            <span className="bar bar--lg"><i style={{ width: pct(job.progress ?? 0) }} /></span>
            <div className="processing__row processing__row--muted">
              <span>
                {stages.length ? `шаг ${(job.stage_index ?? 0) + 1} из ${stages.length}` : 'подготовка'}
              </span>
              {/* Внутри стадии infer прогресс оценочный: Modal отдаёт результат
                  целиком, промежуточного прогресса у него нет. Поэтому здесь
                  «примерно», а не точное время. */}
              <span>{job.eta_s != null ? `осталось ≈ ${job.eta_s} с` : 'время неизвестно'}</span>
            </div>
          </div>
        )}

        {failed && job.raw_response_url && (
          <a
            className="pill pill--ghost pill--lg" href={api.jobRawUrl(job.job_id)}
            target="_blank" rel="noreferrer"
          >Показать ответ модели</a>
        )}

        <div className="processing__actions">
          {failed && (
            <button
              type="button" className="pill pill--dark pill--lg" disabled={retrying}
              onClick={() => {
                setRetrying(true)
                void api.retryJob(video.video_id)
                  .then(setJob)
                  .catch(() => {})
                  .finally(() => setRetrying(false))
              }}
            >{retrying ? 'запускаем…' : '↻ Повторить разметку'}</button>
          )}
          <button
            type="button" className="pill pill--ghost pill--lg"
            onClick={() => void api.getJob(job.job_id).then(setJob).catch(() => {})}
          >↻ Обновить</button>
          <button
            type="button" className="pill pill--dark pill--lg"
            onClick={() => navigate('/')}
          >К списку видео</button>
        </div>
      </div>
    </div>
  )
}
