import { useRef, useState } from 'react'
import { ApiError, api } from '../api/client'
import { bytes, duration as fmtDuration } from '../api/format'
import type { ClientConfig, Video } from '../api/types'

type Item = {
  file: File
  duration?: number
  progress: number
  status: 'checking' | 'ready' | 'uploading' | 'done' | 'existed' | 'rejected'
  reason?: string
}

/** Длительность читается из самого файла до отправки: незачем гнать на сервер
 *  сто мегабайт, чтобы услышать «ролик длиннее тридцати секунд». */
function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const el = document.createElement('video')
    el.preload = 'metadata'
    el.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(el.duration) }
    el.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    el.src = url
  })
}

export function UploadDialog({
  config, onClose, onUploaded,
}: {
  config: ClientConfig
  onClose: () => void
  onUploaded: (video: Video, existed: boolean) => void
}) {
  const [items, setItems] = useState<Item[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const limits = `${config.accepted_mime.map((m) => m.split('/')[1]?.toUpperCase()).join(', ')}`
    + ` · до ${bytes(config.max_size_bytes)} · ${config.min_duration_s}–${config.max_duration_s} секунд`

  async function accept(files: FileList | null) {
    if (!files) return
    const next: Item[] = [...files].map((file) => ({ file, progress: 0, status: 'checking' as const }))
    setItems((prev) => [...prev, ...next])

    for (const item of next) {
      const reason = await reject(item.file)
      setItems((prev) => prev.map((i) => (i.file === item.file
        ? { ...i, status: reason ? 'rejected' : 'ready', reason: reason ?? undefined,
            duration: i.duration }
        : i)))
    }
  }

  async function reject(file: File): Promise<string | null> {
    if (config.accepted_mime.length && file.type && !config.accepted_mime.includes(file.type)) {
      return 'формат не поддерживается'
    }
    if (file.size > config.max_size_bytes) return `больше ${bytes(config.max_size_bytes)}`
    const d = await probeDuration(file)
    if (d === null) return 'файл не читается'
    if (d < config.min_duration_s) return `короче ${config.min_duration_s} с`
    if (d > config.max_duration_s) return `длиннее ${config.max_duration_s} с`
    return null
  }

  async function start() {
    setBusy(true)
    for (const item of items) {
      if (item.status !== 'ready') continue
      setItems((prev) => prev.map((i) => (i.file === item.file ? { ...i, status: 'uploading' } : i)))
      try {
        const { video, existed } = await api.uploadVideo(item.file, (f) =>
          setItems((prev) => prev.map((i) => (i.file === item.file ? { ...i, progress: f } : i))))
        // Дедупликация по содержимому, а не по имени: переименованный файл —
        // тот же ролик. Говорим об этом прямо и называем имя, под которым он
        // уже лежит, иначе пользователь ищет в списке своё новое имя и не
        // находит его.
        setItems((prev) => prev.map((i) => (i.file === item.file
          ? { ...i, status: existed ? 'existed' : 'done', progress: 1,
              reason: existed ? `уже загружен как ${video.filename}` : undefined }
          : i)))
        onUploaded(video, existed)
      } catch (e) {
        const reason = e instanceof ApiError ? e.problem.detail ?? e.problem.title : 'ошибка сети'
        setItems((prev) => prev.map((i) => (i.file === item.file
          ? { ...i, status: 'rejected', reason } : i)))
      }
    }
    setBusy(false)
  }

  const ready = items.filter((i) => i.status === 'ready')
  const totalBytes = ready.reduce((acc, i) => acc + i.file.size, 0)

  return (
    <div className="backdrop" onPointerDown={onClose}>
      <div className="modal modal--upload" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="display modal__title modal__title--lg">Добавить видео</span>
          <button type="button" className="modal__close" onClick={onClose} title="Закрыть">✕</button>
        </div>

        <div
          className={`drop${dragOver ? ' drop--over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); void accept(e.dataTransfer.files) }}
        >
          <span className="drop__icon" aria-hidden="true">↑</span>
          <span className="drop__title">Перетащите видеофайлы сюда</span>
          {/* Ограничения приходят из GET /config: подпись не может разойтись
              с тем, что сервер реально проверяет. */}
          <span className="drop__limits">{limits}</span>
          <button type="button" className="pill pill--paper" onClick={() => input.current?.click()}>
            Выбрать файл
          </button>
          <input
            ref={input} type="file" multiple accept={config.accepted_mime.join(',')}
            className="visually-hidden" onChange={(e) => void accept(e.target.files)}
          />
        </div>

        {items.length > 0 && (
          <div className="files">
            <span className="kicker">Выбранные файлы · {items.length}</span>
            {items.map((i) => (
              <div className="file" key={i.file.name + i.file.size}>
                <span className="file__thumb" />
                <span className="file__meta">
                  <span className="file__name">{i.file.name}</span>
                  <span className="file__sub">
                    {bytes(i.file.size)}
                    {i.duration ? ` · ${fmtDuration(i.duration)}` : ''}
                  </span>
                </span>
                <span className="file__state">
                  {i.status === 'checking' && <span className="file__note">проверяется…</span>}
                  {i.status === 'ready' && <span className="file__note">в очереди</span>}
                  {i.status === 'uploading' && (
                    <>
                      <span className="file__note">Загрузка · {Math.round(i.progress * 100)}%</span>
                      <span className="bar"><i style={{ width: `${i.progress * 100}%` }} /></span>
                    </>
                  )}
                  {i.status === 'done' && <span className="file__note file__note--ok">Загружено</span>}
                  {i.status === 'existed' && (
                    <span className="file__note file__note--warn">{i.reason}</span>
                  )}
                  {i.status === 'rejected' && (
                    <span className="file__note file__note--bad">{i.reason}</span>
                  )}
                </span>
                <button
                  type="button" className="file__remove" title="Убрать"
                  onClick={() => setItems((prev) => prev.filter((x) => x !== i))}
                >✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="modal__foot">
          <span className="modal__note">
            {ready.length
              ? `Всего ${bytes(totalBytes)} · будет обработано ${ready.length}`
              : 'Готовых к загрузке файлов нет'}
          </span>
          <div className="modal__actions">
            <button type="button" className="pill pill--ghost pill--lg" onClick={onClose}>Отмена</button>
            <button
              type="button" className="pill pill--dark pill--lg"
              disabled={!ready.length || busy} onClick={() => void start()}
            >Начать загрузку</button>
          </div>
        </div>
      </div>
    </div>
  )
}
