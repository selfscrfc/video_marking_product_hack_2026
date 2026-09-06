import { api } from './client'
import { MOCK_ENABLED, mockMediaUrl } from '../mock/server'

/** Адрес файла ролика. В моке — настоящий файл из public/mock, если он положен
 *  (`npm run seed`); иначе пусто, и плеер честно показывает заглушку. */
export function videoUrl(videoId: string): string | null {
  if (MOCK_ENABLED) return mockMediaUrl(videoId)
  return api.videoContentUrl(videoId)
}

const frameCache = new Map<string, string>()

/** Кадр по таймкоду.
 *  У сервера для этого есть ручка; в моке её нет, поэтому кадр снимается
 *  с самого файла через canvas — это настоящий кадр ролика, а не заглушка. */
export async function frameAt(videoId: string, at: number, width = 320): Promise<string | null> {
  if (!MOCK_ENABLED) return api.frameUrl(videoId, at, width)

  const src = mockMediaUrl(videoId)
  if (!src) return null
  const key = `${videoId}@${at.toFixed(2)}@${width}`
  const hit = frameCache.get(key)
  if (hit) return hit

  const url = await new Promise<string | null>((resolve) => {
    const video = document.createElement('video')
    video.src = src
    video.muted = true
    video.crossOrigin = 'anonymous'
    video.preload = 'auto'

    const fail = () => resolve(null)
    video.onerror = fail

    video.onloadeddata = () => { video.currentTime = Math.min(at, video.duration - 0.05) }
    video.onseeked = () => {
      const canvas = document.createElement('canvas')
      const scale = width / (video.videoWidth || width)
      canvas.width = width
      canvas.height = Math.round((video.videoHeight || 180) * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) return fail()
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      try { resolve(canvas.toDataURL('image/jpeg', 0.8)) } catch { fail() }
    }
  })

  if (url) frameCache.set(key, url)
  return url
}
