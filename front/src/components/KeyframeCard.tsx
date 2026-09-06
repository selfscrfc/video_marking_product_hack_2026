import { ts, label } from '../api/format'
import type { Annotation, Segment, SegmentPatch } from '../api/types'
import { Keyframe } from './Keyframe'

/** Шаг подвижки кадра кнопками «‹» и «›». */
const NUDGE_S = 0.2

/** Ключевой кадр соседнего шага: что было до выбранного и что после.
 *  Приглушён и меньше — это контекст, а не то, что сейчас правят.
 *  Пустое место под соседа остаётся всегда, иначе на первом и последнем
 *  шаге карточка прыгает по высоте. */
function Near({
  videoId, segment, empty, onOpen,
}: {
  videoId: string
  segment: Segment | null
  empty: string
  onOpen: (segment: Segment) => void
}) {
  if (!segment) {
    return (
      <div className="kf__near kf__near--empty">
        <span className="kf__near-none">{empty}</span>
      </div>
    )
  }
  const range = `${ts(segment.start_s, false)} — ${ts(segment.end_s, false)}`
  return (
    <button
      type="button" className="kf__near"
      title={`${range} · ${label(segment.action, segment.object)} — открыть этот интервал`}
      onClick={() => onOpen(segment)}
    >
      <Keyframe
        videoId={videoId} at={segment.keyframe_ts} width={240}
        className="kf__near-img" placeholder=""
      />
      <span className="kf__near-time">{range}</span>
    </button>
  )
}

export function KeyframeCard({
  videoId, annotation, segment, time, busy, onChange, onOpen,
}: {
  videoId: string
  annotation: Annotation
  segment: Segment | null
  /** Где сейчас стоит плеер — этот кадр и ставится кнопкой «Изменить кадр». */
  time: number
  busy: boolean
  onChange: (patch: SegmentPatch) => void
  onOpen: (segment: Segment) => void
}) {
  const at = (offset: number) =>
    annotation.segments.find((s) => segment && s.index === segment.index + offset) ?? null
  const prev = at(-1)
  const next = at(1)

  const nudge = (delta: number) => {
    if (!segment) return
    const base = segment.keyframe_ts ?? segment.start_s
    onChange({
      keyframe_ts: +Math.min(segment.end_s, Math.max(segment.start_s, base + delta)).toFixed(2),
    })
  }

  return (
    <div className="card kf">
      <div className="kf__head">
        <span className="kicker">Ключевой кадр</span>
        <span className="kf__time">
          {segment?.keyframe_ts != null ? ts(segment.keyframe_ts) : '—'}
        </span>
      </div>

      <Near
        videoId={videoId} segment={prev} onOpen={onOpen}
        empty={segment ? 'это первый интервал' : '—'}
      />

      <Keyframe
        videoId={videoId} at={segment?.keyframe_ts ?? null} width={392}
        className="kf__img" placeholder="кадра нет"
      />

      <Near
        videoId={videoId} segment={next} onOpen={onOpen}
        empty={segment ? 'это последний интервал' : '—'}
      />

      <p className="kf__note">
        {segment
          ? `Кадр, который лучше всего показывает действие интервала ${ts(segment.start_s, false)} — ${ts(segment.end_s, false)}.`
          : 'Выберите интервал на дорожке.'}
      </p>

      <div className="kf__controls">
        <button
          type="button" className="kf__nudge" title={`На ${NUDGE_S} с назад`}
          disabled={!segment || busy}
          onClick={() => nudge(-NUDGE_S)}
        >‹</button>
        <button
          type="button" className="kf__set"
          disabled={!segment || busy}
          title="Поставить ключевым кадр, на котором сейчас стоит плеер"
          onClick={() => segment && onChange({
            keyframe_ts: +Math.min(Math.max(time, segment.start_s), segment.end_s).toFixed(2),
          })}
        >Изменить кадр</button>
        <button
          type="button" className="kf__nudge" title={`На ${NUDGE_S} с вперёд`}
          disabled={!segment || busy}
          onClick={() => nudge(NUDGE_S)}
        >›</button>
      </div>
    </div>
  )
}
