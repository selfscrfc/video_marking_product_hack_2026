import type { CSSProperties } from 'react'
import { ts } from '../api/format'
import type { Segment } from '../api/types'

/** Минимальный просвет между рисками. Меньше — рябит, больше — линейка
 *  перестаёт помогать целиться. */
const TICK_PX = 26
const STEPS = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10]
const MAX_STEP = 10

/** Минимальный зазор между подписями на линейке, долей длительности. */
const LABEL_GAP = 0.02

/** Шаг сетки рисок в секундах: самый мелкий круглый шаг, при котором риски
 *  ещё не ближе TICK_PX друг к другу. Ролик по условию 5–30 секунд, так что
 *  на «весь ролик» это обычно 0.5–1 с, а на самом близком плане — 0.05 с. */
export function gridSeconds(duration: number, zoom: number, viewWidth: number): number {
  if (!viewWidth || !duration) return 1
  const raw = TICK_PX / ((viewWidth * zoom) / duration)
  return STEPS.find((s) => s >= raw) ?? MAX_STEP
}

/** Содержимое линейки: сетка рисок, отметки границ шагов и подписи времени.
 *  Контейнер (`.tl__ruler`) остаётся за вызывающим: на экране проверки он
 *  ловит перемотку и держит бегунок, на экране готовой разметки — нет.
 *  `segments` приходят уже в том виде, в каком их надо показать: на проверке
 *  это значения с учётом текущей протяжки границы. */
export function Ruler({
  segments, duration, grid,
}: {
  segments: Segment[]
  duration: number
  grid: number
}) {
  const pct = (seconds: number) => `${(seconds / duration) * 100}%`

  /* Отметки — все границы шагов, а не только стыки: при разрыве между шагами
     конец одного и начало другого разные точки, и обе надо видеть.
     Подпись ставится не у каждой: две границы в сотых долях друг от друга
     дали бы наложенные надписи, палочки при этом остаются обе. */
  const marks: { at: number; labelled: boolean }[] = []
  for (const s of segments) {
    for (const v of [s.start_s, s.end_s]) {
      if (v <= 0.005 || v >= duration - 0.005) continue
      if (!marks.some((m) => Math.abs(m.at - v) < 0.01)) marks.push({ at: v, labelled: false })
    }
  }
  marks.sort((a, b) => a.at - b.at)
  let lastLabel = 0
  for (const m of marks) {
    if (m.at - lastLabel < duration * LABEL_GAP) continue
    if (duration - m.at < duration * LABEL_GAP) continue
    m.labelled = true
    lastLabel = m.at
  }

  return (
    <>
      <span className="tl__line" />
      {/* Сетка рисок рисуется градиентом, а не элементами: на самом близком
          масштабе их получилось бы под тысячу на дорожку. Крупная риска —
          на целой секунде, если шаг мельче секунды. */}
      <span
        className="tl__grid"
        style={{ '--step': `${(grid / duration) * 100}%` } as CSSProperties}
      />
      <span
        className="tl__grid tl__grid--major"
        style={{ '--step': `${((grid < 1 ? 1 : grid * 5) / duration) * 100}%` } as CSSProperties}
      />
      <span className="tl__tick tl__tick--first">{ts(0, false)}</span>
      <span className="tl__tick tl__tick--last">{ts(duration, false)}</span>
      {marks.map((m, i) => (
        <span key={`m${i}`} className="tl__mark" style={{ left: pct(m.at) }} />
      ))}
      {marks.filter((m) => m.labelled).map((m, i) => (
        <span key={`t${i}`} className="tl__tick" style={{ left: pct(m.at) }}>{ts(m.at, false)}</span>
      ))}
    </>
  )
}
