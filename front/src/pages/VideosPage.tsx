import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../api/client'
import { dateTime, duration as fmtDuration, pct, plural } from '../api/format'
import { videoState } from '../api/state'
import { STATE_TITLES, type Annotation, type Job, type Video, type VideoState } from '../api/types'
import { useConfig } from '../hooks/useConfig'
import { StatusBadge } from '../components/StatusBadge'
import { UploadDialog } from '../components/UploadDialog'

type Row = { video: Video; job?: Job; annotation?: Annotation; state: VideoState }

const FILTERS: (VideoState | 'all')[] = ['all', 'uploading', 'processing', 'review', 'done', 'failed']

export function VideosPage() {
  const navigate = useNavigate()
  const config = useConfig()
  const [rows, setRows] = useState<Row[]>([])
  const [filter, setFilter] = useState<VideoState | 'all'>('all')
  const [query, setQuery] = useState('')
  const [uploading, setUploading] = useState(false)
  // Удаление каскадное: вместе с роликом уходят задачи и разметка. Спрашиваем
  // всегда, а не только когда разметка есть, — иначе привычка кликать «да»
  // выработается на безобидных строках и сработает на нужной.
  const [confirm, setConfirm] = useState<Row | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)

  const load = useCallback(async () => {
    const { items } = await api.listVideos()
    const built = await Promise.all(items.map(async (video): Promise<Row> => {
      const [job, annotation] = await Promise.all([
        video.latest_job_id ? api.getJob(video.latest_job_id).catch(() => undefined) : undefined,
        video.latest_annotation_id
          ? api.getAnnotation(video.latest_annotation_id).catch(() => undefined)
          : undefined,
      ])
      return { video, job, annotation, state: videoState(video, job, annotation) }
    }))
    setRows(built)
  }, [])

  useEffect(() => { void load() }, [load])

  // Пока хоть одна задача считается, список обновляется сам: иначе строка
  // «Обрабатывается · 62%» замирает и выглядит сломанной.
  useEffect(() => {
    if (!rows.some((r) => r.state === 'processing')) return
    const id = setInterval(() => { void load() }, 2000)
    return () => clearInterval(id)
  }, [rows, load])

  const waiting = rows.filter((r) => r.state === 'review').length
  const shown = rows.filter((r) =>
    (filter === 'all' || r.state === filter)
    && r.video.filename.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <div className="screen">
      <header className="topbar">
        <span className="display topbar__brand">Разметка видео</span>
      </header>

      <div className="screen__body">
        <div className="page-head">
          <div className="page-head__title">
            <span className="kicker">Рабочее пространство</span>
            <span className="display page-head__h1">Видео</span>
          </div>
          <span className="page-head__note">
            {rows.length} {plural(rows.length, 'файл', 'файла', 'файлов')}
            {waiting > 0 && <><br />{waiting} {plural(waiting, 'ожидает', 'ожидают', 'ожидают')} проверки</>}
          </span>
          <button
            type="button" className="pill pill--dark pill--lg page-head__cta"
            disabled={!config} onClick={() => setUploading(true)}
          >+ Добавить видео</button>
        </div>

        <div className="filters">
          <input
            className="field filters__search" value={query}
            placeholder="⌕ Поиск по названию файла"
            onChange={(e) => setQuery(e.target.value)}
          />
          {FILTERS.map((f) => (
            <button
              key={f} type="button"
              className={`pill ${filter === f ? 'pill--dark' : 'pill--ghost'} pill--sm`}
              onClick={() => setFilter(f)}
            >{f === 'all' ? 'Все' : STATE_TITLES[f]}</button>
          ))}
        </div>

        {error && (
          <div className="alert">
            <b>{error.problem.title}.</b> {error.problem.detail}
            <button type="button" className="alert__close" onClick={() => setError(null)}>✕</button>
          </div>
        )}

        <div className="table">
          <div className="table__head">
            <span>Файл</span><span>Длительность</span><span>Загружено</span><span>Статус</span>
            <span /><span />
          </div>

          {shown.length === 0 && (
            <div className="table__empty">
              {rows.length === 0 ? 'Ещё ни одного ролика не загружено' : 'Ничего не найдено'}
            </div>
          )}

          {shown.map((row) => {
            const dark = row.state === 'review'
            return (
              <div className={`row${dark ? ' row--dark' : ''}`} key={row.video.video_id}>
                <div className="row__file">
                  <span className="row__thumb" />
                  <span className="row__names">
                    <span className="row__name">{row.video.filename}</span>
                    <span className="row__sub">{subtitle(row)}</span>
                  </span>
                </div>
                <span className="row__dur">
                  {row.video.duration_s ? fmtDuration(row.video.duration_s) : '—'}
                </span>
                <span className="row__date">{dateTime(row.video.created_at)}</span>
                <span className="row__status">
                  {row.state === 'processing' && row.job
                    ? (
                      <>
                        <span className="row__note">
                          Обрабатывается моделью · {pct(row.job.progress ?? 0)}
                        </span>
                        <span className="bar">
                          <i style={{ width: pct(row.job.progress ?? 0) }} />
                        </span>
                      </>
                    )
                    : <StatusBadge state={row.state} onDark={dark} />}
                </span>
                <button
                  type="button"
                  className={`pill ${dark ? 'pill--paper' : 'pill--tint'} row__open`}
                  onClick={() => navigate(`/video/${row.video.video_id}`)}
                >Открыть →</button>
                <button
                  type="button" className="row__del" disabled={deleting === row.video.video_id}
                  title="Удалить ролик"
                  aria-label={`Удалить ${row.video.filename}`}
                  onClick={() => setConfirm(row)}
                >✕</button>
              </div>
            )
          })}
        </div>
      </div>

      {confirm && (
        <div className="backdrop" onPointerDown={() => setConfirm(null)}>
          <div
            className="modal modal--confirm" role="dialog" aria-modal="true"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span className="display modal__title">Удалить ролик?</span>
            <p className="modal__body">
              <b>{confirm.video.filename}</b>
              {confirm.annotation
                ? ` — вместе с ним удалится разметка (${confirm.annotation.segments.length} ${
                  plural(confirm.annotation.segments.length,
                    'интервал', 'интервала', 'интервалов')}).`
                : ' — разметки у него нет.'}
              {' '}Действие необратимо: истории версий в продукте нет.
            </p>
            <div className="modal__foot"><div className="modal__actions">
              <button
                type="button" className="pill pill--ghost pill--lg"
                onClick={() => setConfirm(null)}
              >Отмена</button>
              <button
                type="button" className="pill pill--dark pill--lg"
                disabled={deleting !== null}
                onClick={async () => {
                  const id = confirm.video.video_id
                  setDeleting(id)
                  try {
                    await api.deleteVideo(id)
                    // Убираем строку сразу, не дожидаясь перечитывания списка:
                    // на 18 роликах load() — это ещё и опрос задач, заметная пауза.
                    setRows((rs) => rs.filter((r) => r.video.video_id !== id))
                    setConfirm(null)
                  } catch (e) {
                    setError(e instanceof ApiError ? e : null)
                  } finally {
                    setDeleting(null)
                  }
                }}
              >{deleting ? 'удаляем…' : 'Удалить'}</button>
            </div></div>
          </div>
        </div>
      )}

      {uploading && config && (
        <UploadDialog
          config={config}
          onClose={() => { setUploading(false); void load() }}
          onUploaded={async (video, existed) => {
            // Загрузка сама по себе ничего не даёт: сразу ставим разметку в очередь,
            // иначе ролик повиснет в состоянии «принят, но никем не занят».
            // Уже известный ролик в очередь не ставим: у него своя задача, и
            // повторный вызов вернул бы её же, в том числе упавшую. Перезапуск —
            // это осознанное действие на экране обработки, а не побочный эффект
            // перетаскивания файла.
            if (!existed) await api.createJob(video.video_id).catch(() => undefined)
            void load()
          }}
        />
      )}
    </div>
  )
}

function subtitle(row: Row): string {
  if (row.state === 'failed') return row.job?.error?.title ?? 'Обработка не удалась'
  if (row.state === 'processing') return 'модель определяет действия и объекты'
  if (row.state === 'uploading') return 'ожидает постановки в очередь'
  const n = row.annotation?.segments.length ?? 0
  const review = row.annotation?.stats?.needs_review_count ?? 0
  const base = `${n} ${plural(n, 'интервал', 'интервала', 'интервалов')}`
  return review > 0 ? `${base} · ${review} на проверку` : base
}
