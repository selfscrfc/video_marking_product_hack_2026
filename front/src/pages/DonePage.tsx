import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { ts, dateTime, duration as fmtDuration, label, plural } from '../api/format'
import { videoUrl } from '../api/media'
import type { Annotation, Video } from '../api/types'
import { useAnnotation } from '../hooks/useAnnotation'
import { Keyframe } from '../components/Keyframe'
import { Player } from '../components/Player'
import { DegradedNote } from '../components/DegradedNote'
import { Ruler, gridSeconds } from '../components/Ruler'

/** Выгрузка идёт через fetch, а не по прямой ссылке: сервер валидирует файл
 *  перед отдачей и на отказе присылает problem+json. По <a download> ошибка
 *  утекла бы в скачанный файл, и пользователь получил бы мусор вместо разметки. */
async function download(url: string, filename: string): Promise<string | null> {
  const res = await fetch(url)
  if (!res.ok) {
    try {
      const p = await res.json()
      return p.detail ?? p.title ?? 'Выгрузка не удалась'
    } catch { return 'Выгрузка не удалась' }
  }
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.click()
  URL.revokeObjectURL(href)
  return null
}

export function DonePage({ video, annotationId, onUnreviewed }: {
  video: Video
  annotationId: string
  /** Разметка снята с проверенных — маршрут вернёт экран проверки. */
  onUnreviewed: (annotation: Annotation) => void
}) {
  const navigate = useNavigate()
  const a = useAnnotation(annotationId)
  const ann = a.annotation

  /* Шаг рисок зависит от того, сколько пикселей приходится на секунду,
     поэтому ширину дорожки надо знать. Масштаба здесь нет: ролик всегда
     целиком, править уже нечего. */
  const [trackEl, setTrackEl] = useState<HTMLDivElement | null>(null)
  const [trackWidth, setTrackWidth] = useState(0)
  useEffect(() => {
    if (!trackEl) return
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) setTrackWidth(box.width)
    })
    ro.observe(trackEl)
    return () => ro.disconnect()
  }, [trackEl])

  if (a.loading || !ann) return <div className="screen screen--center">Загружаем разметку…</div>
  const stem = video.filename.replace(/\.[^.]+$/, '')

  return (
    <div className="screen">
      <header className="topbar">
        <button type="button" className="pill pill--ghost" onClick={() => navigate('/')}>
          ← Все видео
        </button>
        <div className="topbar__title">
          <span className="display topbar__name">{video.filename}</span>
          <span className="topbar__meta">
            {fmtDuration(ann.duration_s)} · {ann.segments.length}{' '}
            {plural(ann.segments.length, 'интервал', 'интервала', 'интервалов')}
            {ann.reviewed_at ? ` · проверено ${dateTime(ann.reviewed_at)}` : ''}
          </span>
        </div>
        <span className="badge badge--done"><span aria-hidden="true">✓</span>Успешная разметка</span>
        <div className="topbar__right">
          <button
            type="button" className="pill pill--ghost pill--lg" disabled={a.busy}
            onClick={() => void a.unreview().then((next) => next && onUnreviewed(next))}
          >Вернуться в проверку</button>
        </div>
      </header>

      {a.error && <div className="alert"><b>{a.error.problem.title}.</b> {a.error.problem.detail}</div>}

      {/* Человек, который сейчас нажмёт «Скачать», должен знать, что в файле
          пустые объекты, до того как откроет его. */}
      <DegradedNote
        items={ann.degraded}
        rawUrl={ann.job_id ? api.jobRawUrl(ann.job_id) : null}
      />

      <div className="done">
        <div className="done__main">
          <Player
            src={videoUrl(video.video_id)} duration={ann.duration_s}
            fps={video.fps ?? 30} onTime={() => {}} readOnly
          />
          {/* Линейка та же, что на экране проверки: границы шагов на своих
              местах по времени, а не встык друг за другом. Полоса под ней
              размечена по времени по той же причине — иначе шаг стоял бы не
              под своей отметкой. Подписи 00:00 и конца несёт сама линейка. */}
          <div className="tl__ruler tl__ruler--flat" ref={setTrackEl}>
            <Ruler
              segments={ann.segments} duration={ann.duration_s}
              grid={gridSeconds(ann.duration_s, 1, trackWidth)}
            />
          </div>
          <div className="strip">
            {ann.segments.map((s) => (
              <span
                key={s.index} className="strip__item"
                style={{
                  left: `calc(${(s.start_s / ann.duration_s) * 100}% + 2.5px)`,
                  width: `calc(${((s.end_s - s.start_s) / ann.duration_s) * 100}% - 5px)`,
                }}
                title={`${ts(s.start_s, false)} — ${ts(s.end_s, false)} · ${label(s.action, s.object)}`}
              >{label(s.action, s.object)}</span>
            ))}
          </div>
        </div>

        <aside className="card done__side">
          <span className="kicker">Итоговая разметка</span>
          <div className="done__list">
            {ann.segments.map((s) => (
              <div className="done__item" key={s.index}>
                <Keyframe
                  videoId={video.video_id} at={s.keyframe_ts} width={160}
                  className="done__thumb" placeholder=""
                />
                <span className="done__text">
                  <span className="done__label">{label(s.action, s.object)}</span>
                  <span className="done__range">
                    {ts(s.start_s, false)} — {ts(s.end_s, false)}
                    {s.keyframe_ts !== null && ` · кадр ${ts(s.keyframe_ts)}`}
                  </span>
                </span>
              </div>
            ))}
          </div>

          <div className="export">
            <span className="kicker">Экспорт</span>
            <div className="export__row">
              <button
                type="button" className="pill pill--dark export__btn"
                onClick={() => void download(api.exportUrl(ann.annotation_id, 'json'), `${stem}.json`)}
              >JSON</button>
              <button
                type="button" className="pill pill--tint export__btn"
                onClick={() => void download(api.exportUrl(ann.annotation_id, 'csv'), `${stem}.csv`)}
              >CSV</button>
            </div>
            <span className="export__note">
              Сервер проверяет файл по схеме до отдачи: невалидная выгрузка не уйдёт.
            </span>
          </div>
        </aside>
      </div>
    </div>
  )
}
