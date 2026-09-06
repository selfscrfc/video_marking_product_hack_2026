import type { Degradation } from '../api/types'

/** Полоса «разметка неполная».
 *
 *  Не ошибка: задача прошла, шаги и границы на месте. Молчать всё равно нельзя —
 *  без стадии structure описание остаётся одной строкой, объект пуст, и человек,
 *  который качает выгрузку, должен знать это до того, как её откроет. */
export function DegradedNote({ items, rawUrl }: {
  items: Degradation[] | undefined
  /** Сырой ответ модели: единственное, что можно предъявить, когда разбор не удался. */
  rawUrl?: string | null
}) {
  if (!items?.length) return null
  return (
    <div className="note note--degraded" role="status">
      {items.map((d) => (
        <div key={`${d.stage}:${d.code}`} className="note__line">
          <span className="note__title">{d.title}</span>
          <span className="note__text">{d.impact}</span>
        </div>
      ))}
      {rawUrl && (
        <a className="note__link" href={rawUrl} target="_blank" rel="noreferrer">
          Показать ответ модели
        </a>
      )}
    </div>
  )
}
