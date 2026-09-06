import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ts } from '../api/format'

export interface PlayerHandle {
  seek: (seconds: number) => void
  toggle: () => void
  step: (frames: number) => void
}

interface Props {
  src: string | null
  duration: number
  fps: number
  onTime: (seconds: number) => void
  /** Только просмотр: без транспорта, как на экране готовой разметки. */
  readOnly?: boolean
}

/** Плеер с собственным транспортом: нативные контролы <video> не подчиняются
 *  теме и не дают покадрового шага, который здесь основной жест. */
export const Player = forwardRef<PlayerHandle, Props>(function Player(
  { src, duration, fps, onTime, readOnly = false }, ref,
) {
  const video = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)

  const seek = (seconds: number) => {
    const clamped = Math.max(0, Math.min(duration, seconds))
    setCurrent(clamped)
    onTime(clamped)
    if (video.current) video.current.currentTime = clamped
  }

  const toggle = () => {
    const el = video.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }

  useImperativeHandle(ref, () => ({
    seek, toggle, step: (frames: number) => seek(current + frames / fps),
  }))

  useEffect(() => {
    const el = video.current
    if (!el) return
    const tick = () => { setCurrent(el.currentTime); onTime(el.currentTime) }
    el.addEventListener('timeupdate', tick)
    el.addEventListener('play', () => setPlaying(true))
    el.addEventListener('pause', () => setPlaying(false))
    return () => { el.removeEventListener('timeupdate', tick) }
  }, [onTime])

  // Space — воспроизведение, стрелки — покадрово. Подписано прямо в панели,
  // потому что от скорости этих двух жестов зависит время правки ролика.
  useEffect(() => {
    if (readOnly) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (e.code === 'Space') { e.preventDefault(); toggle() }
      if (e.code === 'ArrowLeft') { e.preventDefault(); seek(current - 1 / fps) }
      if (e.code === 'ArrowRight') { e.preventDefault(); seek(current + 1 / fps) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, fps, readOnly])

  return (
    <div className="player">
      <div className="player__stage">
        {src
          ? <video ref={video} src={src} className="player__video" playsInline preload="metadata" />
          : <span className="player__stub">
              ВИДЕО · файла нет
              <small>положите ролик в public/mock — см. npm run seed</small>
            </span>}
        <button
          type="button" className="player__fs" title="Во весь экран"
          onClick={() => video.current?.requestFullscreen?.()}
        >⛶</button>
      </div>

      {!readOnly && (
        <div className="player__bar">
          <div className="player__transport">
            <button type="button" className="tbtn" title="В начало" onClick={() => seek(0)}>⏮</button>
            <button
              type="button" className="tbtn tbtn--main"
              title={playing ? 'Пауза' : 'Воспроизвести'} onClick={toggle}
            >{playing ? '❚❚' : '▶'}</button>
            <button type="button" className="tbtn" title="В конец" onClick={() => seek(duration)}>⏭</button>
          </div>
          <span className="player__time">
            {ts(current)} <span className="player__total">/ {ts(duration)}</span>
          </span>
          <span className="player__hint">← → покадрово · Space — воспроизведение</span>
        </div>
      )}
    </div>
  )
})
