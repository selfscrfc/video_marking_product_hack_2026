import { useEffect, useRef, useState } from 'react'
import { Ruler } from './Ruler'
import { ts, label } from '../api/format'
import type { Segment, SegmentEdit, SegmentPatch } from '../api/types'

interface Props {
  segments: Segment[]
  duration: number
  currentTime: number
  selected: number | null
  /** Растяжение дорожки: 1 — весь ролик в ширину экрана. */
  zoom: number
  /** Шаг сетки рисок в секундах, из gridSeconds(). */
  grid: number
  onSelect: (index: number) => void
  onSeek: (seconds: number) => void
  /** Правки одной протяжки: сначала поджатый сосед, потом сам интервал. */
  onCommit: (edits: SegmentEdit[]) => void
  /** Индекс интервала, границу которого сейчас тянут, или null. Экран проверки
   *  показывает по нему строку о несохранённой правке. */
  onDrag: (index: number | null) => void
}

export type { SegmentEdit }

type Drag = {
  index: number
  edge: 'start' | 'end'
  start_s: number
  end_s: number
  /** Сосед, которого поджала протяжка, и его новая граница. */
  push: SegmentEdit | null
}

/** Минимальная длина шага при перетаскивании. Ноль дал бы вырожденный шаг,
 *  который сервер всё равно отвергнет как segment_inverted. */
export const MIN_LEN = 0.1

/** Зазор между блоками интервалов, как в макете. Половина уходит на каждую
 *  сторону блока, чтобы границы всё равно совпадали с засечками линейки. */
const GAP = 5

/** У самых краёв дорожки подпись бегунка не центрируется, а прижимается:
 *  иначе на нуле её половина уезжает за обрез. */
function headEdge(time: number, duration: number): string {
  const p = duration ? time / duration : 0
  if (p < 0.03) return ' tl__head-label--start'
  if (p > 0.97) return ' tl__head-label--end'
  return ''
}

export function Timeline({
  segments, duration, currentTime, selected, zoom, grid,
  onSelect, onSeek, onCommit, onDrag,
}: Props) {
  const view = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [scrub, setScrub] = useState(false)

  /* onSeek приходит новой функцией на каждый кадр перемотки. Держим её в
     ссылке, иначе слушатели перевешивались бы между событиями мыши. */
  const seekRef = useRef(onSeek)
  useEffect(() => { seekRef.current = onSeek }, [onSeek])

  const pct = (seconds: number) => `${(seconds / duration) * 100}%`

  const timeAt = (clientX: number): number => {
    const box = track.current?.getBoundingClientRect()
    if (!box || box.width === 0) return 0
    return Math.max(0, Math.min(duration, ((clientX - box.left) / box.width) * duration))
  }

  /* Перетаскивание границы. Пока тянут — состояние локальное: запрос на
     каждый пиксель мыши превратил бы правку в очередь из сотни PATCH.
     На отпускании уходит один. */
  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const t = timeAt(e.clientX)
      setDrag((d) => {
        if (!d) return d
        const prev = segments.find((s) => s.index === d.index - 1)
        const next = segments.find((s) => s.index === d.index + 1)
        /* Дойдя до соседа, граница не упирается, а двигает его: сосед
           поджимается до своей минимальной длины и дальше не пускает.
           Назад сосед не разжимается — так остаётся способ оставить разрыв. */
        if (d.edge === 'start') {
          const floor = prev ? prev.start_s + MIN_LEN : 0
          const start_s = Math.max(floor, Math.min(t, d.end_s - MIN_LEN))
          const push = prev && start_s < prev.end_s
            ? { index: prev.index, patch: { end_s: +start_s.toFixed(2) } }
            : null
          return { ...d, start_s, push }
        }
        const ceil = next ? next.end_s - MIN_LEN : duration
        const end_s = Math.min(ceil, Math.max(t, d.start_s + MIN_LEN))
        const push = next && end_s > next.start_s
          ? { index: next.index, patch: { start_s: +end_s.toFixed(2) } }
          : null
        return { ...d, end_s, push }
      })
    }
    /* Отправка живёт здесь, а не внутри setDrag: StrictMode в dev вызывает
       апдейтер состояния дважды, и запрос из него уходил бы дважды тоже.
       Второй заход шёл со старой версией, ловил 409 и отправлял хук
       перечитывать разметку — экран на секунду подменялся загрузкой.
       `drag` в замыкании свежий: эффект пересоздаётся на каждое движение. */
    const up = () => {
      const d = drag
      setDrag(null)
      onDrag(null)
      const original = segments.find((s) => s.index === d.index)
      const patch: SegmentPatch = d.edge === 'start'
        ? { start_s: +d.start_s.toFixed(2) }
        : { end_s: +d.end_s.toFixed(2) }
      const unchanged = original && (d.edge === 'start'
        ? Math.abs(original.start_s - d.start_s) < 0.005
        : Math.abs(original.end_s - d.end_s) < 0.005)
      // Сосед идёт первым: если сначала растянуть свой шаг, сервер
      // отвергнет его как пересечение, которого через шаг уже не будет.
      const edits: SegmentEdit[] = d.push ? [d.push] : []
      if (!unchanged) edits.push({ index: d.index, patch })
      if (edits.length) onCommit(edits)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag, segments, duration, onCommit, onDrag])

  /* Перемотка протаскиванием, а не только нажатием: попасть в момент начала
     действия с одного клика нельзя, а на глаз по кадру — можно. */
  useEffect(() => {
    if (!scrub) return
    const move = (e: PointerEvent) => { e.preventDefault(); seekRef.current(timeAt(e.clientX)) }
    const stop = () => setScrub(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [scrub])

  /* При увеличении масштаба дорожка шире экрана. Держим выбранный интервал в
     поле зрения: иначе после зума разметчик смотрит на чужой участок ролика. */
  useEffect(() => {
    const v = view.current
    const s = segments.find((x) => x.index === selected)
    if (!v || !s || v.scrollWidth <= v.clientWidth) return
    const center = ((s.start_s + s.end_s) / 2 / duration) * v.scrollWidth
    v.scrollTo({ left: center - v.clientWidth / 2, behavior: 'smooth' })
  }, [zoom, selected, duration])

  const at = (s: Segment): Segment => {
    if (!drag) return s
    if (drag.index === s.index) return { ...s, start_s: drag.start_s, end_s: drag.end_s }
    if (drag.push?.index === s.index) return { ...s, ...drag.push.patch }
    return s
  }

  return (
    <div className={`tl${scrub ? ' tl--scrub' : ''}`}>
      <div className="tl__view" ref={view}>
        <div className="tl__track" ref={track} style={{ width: `${zoom * 100}%` }}>
          <div
            className="tl__ruler"
            onPointerDown={(e) => { e.preventDefault(); setScrub(true); onSeek(timeAt(e.clientX)) }}
            role="slider"
            aria-label="Позиция в ролике"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={currentTime}
            tabIndex={0}
          >
            <Ruler segments={segments.map(at)} duration={duration} grid={grid} />
          </div>

          {/* Все интервалы в одном ряду: ширина блока — это длительность шага.
              Строка на интервал давала на длинном ролике десяток строк и
              вертикальный скролл, из-за которого дорожку не видно целиком. */}
          <div className="tl__row">
            {segments.map((raw) => {
              const s = at(raw)
              const isSelected = selected === s.index
              return (
                <div
                  key={s.index}
                  className={`seg${isSelected ? ' seg--selected' : ''}${s.needs_review ? ' seg--review' : ''}`}
                  style={{
                    left: `calc(${pct(s.start_s)} + ${GAP / 2}px)`,
                    width: `calc(${pct(s.end_s - s.start_s)} - ${GAP}px)`,
                  }}
                  onPointerDown={() => onSelect(s.index)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') onSelect(s.index) }}
                  /* Штрих слева говорит «посмотри сюда», но не говорит почему:
                     слово «на проверку» в блок при десятке интервалов не
                     влезает. Причина — здесь. */
                  title={[
                    `${ts(s.start_s, false)} — ${ts(s.end_s, false)}`,
                    label(s.action, s.object),
                    s.needs_review
                      ? s.confidence !== null
                        ? `нужна проверка: уверенность модели ${s.confidence.toFixed(2)}`
                        : 'нужна проверка'
                      : null,
                  ].filter(Boolean).join(' · ')}
                >
                  <span className="seg__label">
                    {s.action && s.object
                      ? <>{s.action}<br />{s.object}</>
                      : label(s.action, s.object)}
                  </span>

                  {isSelected && (
                    <>
                      <span
                        className="seg__handle seg__handle--l"
                        title="Сдвинуть начало"
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          onDrag(s.index)
                          setDrag({ index: s.index, edge: 'start', start_s: s.start_s, end_s: s.end_s, push: null })
                        }}
                      />
                      <span
                        className="seg__handle seg__handle--r"
                        title="Сдвинуть конец"
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          onDrag(s.index)
                          setDrag({ index: s.index, edge: 'end', start_s: s.start_s, end_s: s.end_s, push: null })
                        }}
                      />
                    </>
                  )}
                </div>
              )
            })}
          </div>

          <span className="tl__head" style={{ left: pct(currentTime) }}>
            <span
              className={`tl__head-label${headEdge(currentTime, duration)}`}
              title="Перетащите, чтобы перемотать"
              onPointerDown={(e) => { e.preventDefault(); setScrub(true) }}
            >
              {ts(currentTime).slice(3)}
            </span>
          </span>
        </div>
      </div>
    </div>
  )
}

/** Незакрытые участки ролика. В эталонных данных они есть — например, первые
 *  две секунды до начала действия, — и молчать о них нельзя: разметчик должен
 *  видеть, что покрытие неполное, до того как нажмёт «Завершить». */
export function gaps(segments: Segment[], duration: number): [number, number][] {
  const out: [number, number][] = []
  let cursor = 0
  for (const s of [...segments].sort((a, b) => a.start_s - b.start_s)) {
    if (s.start_s - cursor > 0.25) out.push([cursor, s.start_s])
    cursor = Math.max(cursor, s.end_s)
  }
  if (duration - cursor > 0.25) out.push([cursor, duration])
  return out
}
