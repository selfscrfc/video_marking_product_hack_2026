import type { VideoState } from '../api/types'
import { STATE_TITLES } from '../api/types'

const MARK: Record<VideoState, string> = {
  uploading: '↑', processing: '◐', review: '●', done: '✓', failed: '!',
}

/** Статус ролика одной пилюлей. На тёмной строке фон светлый, и наоборот —
 *  иначе на выделенной строке значок пропадает. */
export function StatusBadge({ state, onDark = false }: { state: VideoState; onDark?: boolean }) {
  return (
    <span className={`badge badge--${state}${onDark ? ' badge--on-dark' : ''}`}>
      <span aria-hidden="true">{MARK[state]}</span>
      {STATE_TITLES[state]}
    </span>
  )
}
