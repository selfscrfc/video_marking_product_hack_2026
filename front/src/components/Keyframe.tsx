import { useEffect, useState } from 'react'
import { frameAt } from '../api/media'

interface Props {
  videoId: string
  at: number | null
  width?: number
  className?: string
  /** Что показать, пока кадра нет. Заглушка честная: кадра действительно нет. */
  placeholder?: string
}

/** Кадр ролика по таймкоду.
 *  Настоящий бэкенд отдаёт его ручкой /videos/{id}/frame; в моке кадр снимается
 *  с файла через canvas. Ни в одном из режимов сюда не подставляется картинка,
 *  не имеющая отношения к ролику. */
export function Keyframe({ videoId, at, width = 320, className, placeholder = 'кадр' }: Props) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    setSrc(null)
    setFailed(false)
    if (at === null) return setFailed(true)
    void frameAt(videoId, at, width).then((url) => {
      if (!alive) return
      if (url) setSrc(url)
      else setFailed(true)
    })
    return () => { alive = false }
  }, [videoId, at, width])

  // onError обязателен на боевом пути: там src — это URL ручки, а не data-URL,
  // и 404 или 422 от неё иначе покажутся сломанной картинкой браузера вместо
  // честной заглушки. В моке кадр рисуется в canvas и упасть уже не может.
  if (src) {
    return (
      <img
        className={`frame ${className ?? ''}`} src={src} alt=""
        onError={() => { setSrc(null); setFailed(true) }}
      />
    )
  }
  return (
    <span className={`frame frame--empty ${className ?? ''}`}>
      {failed ? placeholder : '…'}
    </span>
  )
}
