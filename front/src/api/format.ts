/** 6.42 -> «00:06.42». Сотые, а не десятые: границы хранятся и уходят в
 *  выгрузку с точностью до сотой, и показывать грубее значит врать о том,
 *  что записано. Считаем сразу в сотых, чтобы 6.999 не превратилось в 00:06.99. */
export function ts(seconds: number, frac = true): string {
  const total = Math.round(Math.max(0, seconds) * 100)
  const m = Math.floor(total / 6000)
  const sec = Math.floor((total % 6000) / 100)
  const head = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return frac ? `${head}.${String(total % 100).padStart(2, '0')}` : head
}

/** Длительность без долей: «00:18». */
export const duration = (s: number) => ts(s, false)

/** Обратно к секундам: «00:04.53», «4.53», «4,53» -> 4.53.
 *  null — это не время, и поле надо вернуть к прежнему значению. */
export function parseTs(text: string): number | null {
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(text.trim().replace(',', '.'))
  if (!m) return null
  const mins = m[1] ? Number(m[1]) : 0
  const secs = Number(m[2] ?? '')
  if (!Number.isFinite(mins) || !Number.isFinite(secs)) return null
  return +(mins * 60 + secs).toFixed(2)
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} Б`
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} КБ`
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} МБ`
  return `${(n / 1024 ** 3).toFixed(1)} ГБ`
}

export function dateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} · ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** «поднял кружку» — то, что видно на дорожке и в списке.
 *  Пустое действие — это не «нечего показать», а сигнал: модель не разобрала. */
export function label(action: string, object: string): string {
  const t = [action, object].filter(Boolean).join(' ').trim()
  return t || 'без описания'
}

export const pct = (x: number) => `${Math.round(x * 100)}%`

/** Русские числительные: «1 файл», «2 файла», «5 файлов». */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10, mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}
