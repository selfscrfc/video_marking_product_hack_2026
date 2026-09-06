import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { ClientConfig } from '../api/types'

let cached: ClientConfig | null = null

/** Лимиты берутся у сервера, а не зашиваются в интерфейс: иначе подпись в
 *  дропзоне однажды разойдётся с тем, что сервер реально проверяет. */
export function useConfig(): ClientConfig | null {
  const [config, setConfig] = useState<ClientConfig | null>(cached)
  useEffect(() => {
    if (cached) return
    void api.config().then((c) => { cached = c; setConfig(c) }).catch(() => {})
  }, [])
  return config
}
