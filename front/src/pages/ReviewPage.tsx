import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ts, duration as fmtDuration, plural } from '../api/format'
import { videoUrl } from '../api/media'
import type { Annotation, Video } from '../api/types'
import { useAnnotation } from '../hooks/useAnnotation'
import { api } from '../api/client'
import { DegradedNote } from '../components/DegradedNote'
import { IntervalPanel } from '../components/IntervalPanel'
import { KeyframeCard } from '../components/KeyframeCard'
import { Player, type PlayerHandle } from '../components/Player'
import { Timeline, gaps } from '../components/Timeline'
import { gridSeconds } from '../components/Ruler'

/** Масштабы заданы не множителем, а тем, сколько секунд ролика видно на
 *  экране: множитель сам по себе ничего не говорит, а «видно 2 секунды» —
 *  говорит. Ролик по условию 5–30 секунд, поэтому на коротком часть вариантов
 *  совпала бы с «весь ролик» — такие гасим, а не прячем, чтобы кнопки не
 *  прыгали при переходе между роликами. */
const ZOOMS = [
  { window: Infinity, title: 'весь ролик' },
  { window: 10, title: '10 с' },
  { window: 4, title: '4 с' },
  { window: 2, title: '2 с' },
]

const zoomFor = (duration: number, window: number) =>
  Number.isFinite(window) ? Math.max(1, +(duration / window).toFixed(2)) : 1

export function ReviewPage({ video, annotationId, onReviewed }: {
  video: Video
  annotationId: string
  /** Разметка завершена — маршрут по ней переключится на экран готовой. */
  onReviewed: (annotation: Annotation) => void
}) {
  const navigate = useNavigate()
  const a = useAnnotation(annotationId)
  const player = useRef<PlayerHandle>(null)

  const [selected, setSelected] = useState<number | null>(0)
  const [time, setTime] = useState(0)
  const [zoomIdx, setZoomIdx] = useState(0)
  const [dragging, setDragging] = useState<number | null>(null)

  /* Ширина редактора нужна для подписи «N с / деление»: сколько секунд
     умещается в деление, зависит от того, сколько пикселей на экране. */
  const [editorEl, setEditorEl] = useState<HTMLDivElement | null>(null)
  const [editorWidth, setEditorWidth] = useState(0)
  useEffect(() => {
    if (!editorEl) return
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) setEditorWidth(box.width)
    })
    ro.observe(editorEl)
    return () => ro.disconnect()
  }, [editorEl])

  const ann = a.annotation
  const segment = ann?.segments.find((s) => s.index === selected) ?? null
  const holes = useMemo(() => (ann ? gaps(ann.segments, ann.duration_s) : []), [ann])

  /* Курсор ведёт выбор, но только когда он сам перешёл в другой шаг. Сравнивать
     с текущим выбором нельзя: тогда клик по соседнему интервалу тут же
     отменялся бы обратно к шагу под курсором.
     В разрыве между шагами выбор не сбрасываем: пустая панель на паузе между
     действиями только мешает — правят всё равно последний тронутый шаг. */
  const underIndex = ann?.segments.find((s) => time >= s.start_s && time < s.end_s)?.index ?? null
  const lastUnder = useRef<number | null>(null)
  useEffect(() => {
    if (lastUnder.current === underIndex) return
    lastUnder.current = underIndex
    if (underIndex !== null) setSelected(underIndex)
  }, [underIndex])

  if (a.loading || !ann) return <div className="screen screen--center">Загружаем разметку…</div>

  const seek = (t: number) => { player.current?.seek(t); setTime(t) }
  const dragged = ann.segments.find((s) => s.index === dragging) ?? null
  const zoom = zoomFor(ann.duration_s, ZOOMS[zoomIdx]?.window ?? Infinity)
  const grid = gridSeconds(ann.duration_s, zoom, editorWidth)

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
            {' · '}{describeConfidence(ann)}
          </span>
        </div>
        <div className="topbar__right">
          {/* Кнопки «Сохранить» здесь нет намеренно: каждая правка уходит на
              сервер сразу, отдельным PATCH с If-Match. Показываем состояние
              сохранения, а не предлагаем нажать то, что уже произошло. */}
          <span className={`saved${a.busy ? ' saved--busy' : ''}`}>
            {a.busy ? 'сохраняем…' : `версия ${ann.version} · сохранено`}
          </span>
          <button
            type="button" className="pill pill--dark pill--lg"
            disabled={a.busy || ann.segments.length === 0}
            onClick={() => void a.review().then((next) => next && onReviewed(next))}
          >Завершить разметку</button>
        </div>
      </header>

      {a.error && (
        <div className="alert">
          <b>{a.error.problem.title}.</b> {a.error.problem.detail}
          <button type="button" className="alert__close" onClick={a.clearError}>✕</button>
        </div>
      )}

      {/* Состояние данных, а не ошибка действия: крестика нет, закрыть нельзя. */}
      <DegradedNote
        items={ann.degraded}
        rawUrl={ann.job_id ? api.jobRawUrl(ann.job_id) : null}
      />

      <div className="review">
        <aside className="review__side">
          <IntervalPanel
            annotation={ann}
            segment={segment}
            busy={a.busy}
            onChange={(patch) => segment && void a.patchSegment(segment.index, patch)}
          />
        </aside>

        <main className="review__main">
          <Player
            ref={player}
            src={videoUrl(video.video_id)}
            duration={ann.duration_s}
            fps={video.fps ?? 30}
            onTime={setTime}
          />
        </main>

        <aside className="review__kf">
          <KeyframeCard
            videoId={video.video_id}
            annotation={ann}
            segment={segment}
            time={time}
            busy={a.busy}
            onChange={(patch) => segment && void a.patchSegment(segment.index, patch)}
            onOpen={(s) => { setSelected(s.index); seek(s.keyframe_ts ?? s.start_s) }}
          />
        </aside>
      </div>

      <div className="editor" ref={setEditorEl}>
        <div className="toolbar">
          <button
            type="button" className="pill pill--paper"
            title="Новый интервал от позиции плеера"
            onClick={() => {
              const end = Math.min(ann.duration_s, time + 2)
              if (end - time > 0.2) void a.addSegment(+time.toFixed(2), +end.toFixed(2))
            }}
          >+ Добавить интервал</button>
          <button
            type="button" className="pill pill--paper"
            disabled={!segment || time <= (segment?.start_s ?? 0) || time >= (segment?.end_s ?? 0)}
            title="Разрезать выбранный интервал по позиции плеера"
            onClick={() => segment && void a.splitSegment(segment.index, +time.toFixed(2))}
          >⌗ Разделить</button>
          <button
            type="button" className="pill pill--paper"
            disabled={!segment || segment.index >= ann.segments.length - 1}
            title="Слить выбранный интервал со следующим"
            onClick={() => segment && void a.mergeSegment(segment.index, 'next')}
          >⇥⇤ Объединить</button>
          <button
            type="button" className="pill pill--paper pill--danger"
            disabled={!segment || a.busy}
            title="Удалить выбранный интервал"
            onClick={() => {
              if (!segment) return
              void a.deleteSegment(segment.index)
              setSelected(null)
            }}
          >✕ Удалить интервал</button>

          <div className="zoombox">
            <span className="zoombox__title">Видно</span>
            <div className="zoombox__set" role="group" aria-label="Масштаб дорожки">
              {ZOOMS.map((z, i) => {
                // вариант, который на этом ролике не крупнее «всего ролика»,
                // нажимать бессмысленно
                const same = Number.isFinite(z.window) && ann.duration_s / z.window <= 1.001
                return (
                  <button
                    key={z.title} type="button"
                    className={`pill pill--sm ${i === zoomIdx ? 'pill--dark' : 'pill--paper'}`}
                    disabled={same}
                    title={same ? 'Ролик и так короче' : `Масштаб ×${zoomFor(ann.duration_s, z.window)}`}
                    onClick={() => setZoomIdx(i)}
                  >{z.title}</button>
                )
              })}
            </div>
            <span className="zoombox__step">риска {grid < 1 ? grid : grid.toFixed(0)} с</span>
          </div>
        </div>

        <Timeline
          segments={ann.segments}
          duration={ann.duration_s}
          currentTime={time}
          selected={selected}
          zoom={zoom}
          grid={grid}
          onSelect={setSelected}
          onSeek={seek}
          onCommit={(edits) => void a.patchSegments(edits)}
          onDrag={setDragging}
        />

        <div className="tl__notes">
          <span>Границы перетаскиваются · выбранный интервал редактируется в панели слева</span>
          <span className="tl__notes-r">
            При коротких интервалах увеличьте масштаб — блоки станут шире, подписи целиком
          </span>
        </div>

        <div className="editor__foot">
          {dragged
            ? (
              <span className="editor__dirty">
                Есть несохранённые изменения границ интервала{' '}
                {ts(dragged.start_s, false)} — {ts(dragged.end_s, false)}
              </span>
            )
            : a.busy
              ? <span className="editor__dirty">Сохраняем правку…</span>
              : null}
          <span className={`editor__coverage${holes.length ? ' editor__coverage--warn' : ''}`}>
            {holes.length === 0
              ? 'Вся длительность видео покрыта интервалами, пропусков нет.'
              : `Не покрыто ${holes.length} ${plural(holes.length, 'участок', 'участка', 'участков')}: `
                + holes.map(([f, t]) => `${ts(f, false)}–${ts(t, false)}`).join(', ')}
          </span>
        </div>
      </div>
    </div>
  )
}

function describeConfidence(ann: Annotation): string {
  const values = ann.segments.map((s) => s.confidence).filter((c): c is number => c !== null)
  if (!values.length) return 'уверенность не проставлена'
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const review = ann.stats?.needs_review_count ?? 0
  const head = `средняя уверенность модели ${mean.toFixed(2)}`
  return review ? `${head} · ${review} на проверку` : head
}
