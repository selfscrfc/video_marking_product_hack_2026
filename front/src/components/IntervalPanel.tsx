import { useEffect, useRef, useState } from 'react'
import { ts, label, parseTs } from '../api/format'
import type { Annotation, Segment, SegmentPatch } from '../api/types'
import { MIN_LEN } from './Timeline'

/** Точный ввод одной границы. Протяжкой мышью до сотой не попасть, а допуск
 *  в кейсе — две секунды на границу: разница между «почти попал» и «попал»
 *  решается здесь, а не на дорожке.
 *  В отличие от протяжки соседа не двигает: опечатка в поле не должна
 *  молча перекроить соседний шаг, поэтому значение просто зажимается. */
function Bound({
  title, value, min, max, disabled, onCommit,
}: {
  title: string
  value: number
  min: number
  max: number
  disabled: boolean
  onCommit: (seconds: number) => void
}) {
  const [text, setText] = useState(() => ts(value))
  useEffect(() => { setText(ts(value)) }, [value])

  const commit = () => {
    const parsed = parseTs(text)
    if (parsed === null || min > max) return setText(ts(value))
    const clamped = +Math.min(max, Math.max(min, parsed)).toFixed(2)
    setText(ts(clamped))
    if (Math.abs(clamped - value) >= 0.005) onCommit(clamped)
  }

  return (
    <input
      className="field field--sm bounds__field"
      value={text}
      disabled={disabled}
      aria-label={title}
      title={`${title}: от ${ts(min)} до ${ts(max)}`}
      inputMode="decimal"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') setText(ts(value))
      }}
    />
  )
}

/** Варианты для быстрого выбора — слова, уже использованные в этом же ролике.
 *  Фиксированного словаря действий у продукта нет и быть не может: домен
 *  заранее неизвестен. Поэтому подсказки берутся из соседних шагов, а любое
 *  своё значение вводится текстом. */
function vocabulary(ann: Annotation, field: 'action' | 'object'): string[] {
  const counts = new Map<string, number>()
  for (const s of ann.segments) {
    const v = s[field].trim()
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v)
}

/** Словарь ролика, который не забывает.
 *
 *  Считать его только по текущей разметке нельзя: слово, встречавшееся ровно в
 *  одном шаге, исчезает из списка в тот момент, когда этот шаг переименовали.
 *  То есть предыдущий вариант пропадает ровно тогда, когда он нужнее всего —
 *  чтобы вернуться, передумав. Поэтому всё, что здесь когда-либо было видно,
 *  остаётся до конца работы с роликом.
 *
 *  Порядок задаёт текущая разметка (частые слова выше), а забытые встают
 *  следом: они не должны вытеснять то, что действительно используется. */
function useVocabulary(ann: Annotation, field: 'action' | 'object'): string[] {
  const seen = useRef<Set<string>>(new Set())
  const annotationId = ann.annotation_id
  const lastId = useRef(annotationId)
  if (lastId.current !== annotationId) {
    // Другой ролик — другой словарь. Слова прошлого сюда не переносятся.
    seen.current = new Set()
    lastId.current = annotationId
  }
  const current = vocabulary(ann, field)
  for (const v of current) seen.current.add(v)
  const rest = [...seen.current].filter((v) => !current.includes(v)).sort()
  return [...current, ...rest]
}

function Choice({
  title, value, options, placeholder, disabled, onPick,
}: {
  title: string
  value: string
  options: string[]
  placeholder: string
  disabled: boolean
  onPick: (v: string) => void
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (!v) return
    onPick(v)
    setDraft('')
  }

  return (
    <div className="choice">
      <span className="kicker">{title}</span>
      <div className="choice__chips">
        {options.length === 0 && (
          <span className="choice__empty">В этом ролике таких слов ещё нет</span>
        )}
        {options.map((o) => (
          <button
            key={o} type="button"
            className={`pill pill--sm ${o === value ? 'pill--dark' : 'pill--tint'}`}
            disabled={disabled}
            onClick={() => onPick(o)}
          >{o}</button>
        ))}
      </div>
      <div className="choice__row">
        <input
          className="field field--sm" value={draft} placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
        />
        <button
          type="button" className="choice__add"
          disabled={disabled || !draft.trim()}
          title={`Добавить ${title.toLowerCase()}`}
          onClick={add}
        >+</button>
      </div>
    </div>
  )
}

/** Постоянная панель правки выбранного интервала.
 *  Раньше действие и объект правились в модалке: она закрывала дорожку и
 *  видео, а разметчик как раз сверяет слово с кадром. Здесь правка идёт
 *  рядом с плеером и уходит на сервер сразу, как и все прочие. */
export function IntervalPanel({
  annotation, segment, busy, onChange,
}: {
  annotation: Annotation
  segment: Segment | null
  busy: boolean
  onChange: (patch: SegmentPatch) => void
}) {
  const actions = useVocabulary(annotation, 'action')
  const objects = useVocabulary(annotation, 'object')

  const prev = segment && annotation.segments.find((s) => s.index === segment.index - 1)
  const next = segment && annotation.segments.find((s) => s.index === segment.index + 1)

  return (
    <div className="card ivl">
      <div className="ivl__head">
        <span className="kicker">Интервал</span>
        <span className="ivl__time">
          {segment ? `${ts(segment.start_s)} — ${ts(segment.end_s)}` : '—'}
        </span>
      </div>

      <div className="ivl__now">
        <span className="ivl__now-title">размечено</span>
        <span className="display ivl__now-value">
          {segment ? label(segment.action, segment.object) : 'интервал не выбран'}
        </span>
      </div>

      {segment
        ? (
          <div className="ivl__body" key={segment.index}>
            <div className="bounds">
              <span className="kicker">Границы</span>
              <div className="bounds__row">
                <Bound
                  title="Начало" value={segment.start_s}
                  min={prev ? prev.end_s : 0}
                  max={segment.end_s - MIN_LEN}
                  disabled={busy}
                  onCommit={(v) => onChange({ start_s: v })}
                />
                <span className="bounds__dash">—</span>
                <Bound
                  title="Конец" value={segment.end_s}
                  min={segment.start_s + MIN_LEN}
                  max={next ? next.start_s : annotation.duration_s}
                  disabled={busy}
                  onCommit={(v) => onChange({ end_s: v })}
                />
              </div>
              <span className="bounds__len">
                длительность {(segment.end_s - segment.start_s).toFixed(2)} с
              </span>
            </div>

            <Choice
              title="Действие" value={segment.action} options={actions}
              placeholder="своё действие" disabled={busy}
              onPick={(v) => onChange({ action: v })}
            />
            <Choice
              title="Объект" value={segment.object} options={objects}
              placeholder="свой объект" disabled={busy}
              onPick={(v) => onChange({ object: v })}
            />
          </div>
        )
        : <p className="ivl__hint">Выберите интервал на дорожке — здесь появятся действие и объект.</p>}
    </div>
  )
}
