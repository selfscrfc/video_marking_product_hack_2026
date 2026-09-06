import { useEffect, useState } from 'react'
import { BrowserRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { ApiError, api } from './api/client'
import { videoState } from './api/state'
import type { Annotation, Job, Video } from './api/types'
import { VideosPage } from './pages/VideosPage'
import { ProcessingPage } from './pages/ProcessingPage'
import { ReviewPage } from './pages/ReviewPage'
import { DonePage } from './pages/DonePage'

/** Один адрес на ролик; каким экраном он обернётся, решает состояние.
 *  Разные маршруты на обработку и на проверку означали бы, что ссылку,
 *  отправленную коллеге пять минут назад, откроет не тот экран. */
function VideoRoute() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [video, setVideo] = useState<Video | null>(null)
  const [job, setJob] = useState<Job | undefined>()
  const [annotation, setAnnotation] = useState<Annotation | undefined>()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const v = await api.getVideo(id)
        if (!alive) return
        setVideo(v)
        const [j, a] = await Promise.all([
          v.latest_job_id ? api.getJob(v.latest_job_id).catch(() => undefined) : undefined,
          v.latest_annotation_id
            ? api.getAnnotation(v.latest_annotation_id).catch(() => undefined)
            : undefined,
        ])
        if (!alive) return
        setJob(j)
        setAnnotation(a)
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e.problem.title : 'Ролик не открылся')
      }
    })()
    return () => { alive = false }
  }, [id])

  if (error) {
    return (
      <div className="screen screen--center">
        <div className="processing">
          <span className="display processing__title">{error}</span>
          <button type="button" className="pill pill--dark pill--lg" onClick={() => navigate('/')}>
            К списку видео
          </button>
        </div>
      </div>
    )
  }
  if (!video) return <div className="screen screen--center">Открываем ролик…</div>

  const state = videoState(video, job, annotation)

  if (state === 'processing' || state === 'failed') {
    if (!job) return <div className="screen screen--center">Задача не найдена</div>
    return (
      <ProcessingPage
        video={video} job={job}
        onFinished={(done) => { void (async () => {
          // Разметку тянем до того, как объявить задачу готовой: иначе на один
          // кадр состояние окажется «задача есть, разметки нет» и мелькнёт
          // экран «ролик принят, но не поставлен в очередь».
          const ann = done.annotation_id
            ? await api.getAnnotation(done.annotation_id).catch(() => undefined)
            : undefined
          setAnnotation(ann)
          setJob(done)
        })() }}
      />
    )
  }
  if (state === 'uploading') {
    return (
      <div className="screen screen--center">
        <div className="processing">
          <span className="display processing__title">Ролик принят, но не поставлен в очередь</span>
          <p className="processing__note">Разметка ещё не запускалась.</p>
          <button
            type="button" className="pill pill--dark pill--lg"
            onClick={() => void api.createJob(video.video_id).then((j) => setJob(j))}
          >Запустить разметку</button>
        </div>
      </div>
    )
  }
  if (!annotation) return <div className="screen screen--center">Разметки нет</div>

  /* Экран выбирается по состоянию разметки, поэтому «Завершить разметку» и
     «Вернуться в проверку» не навигируют никуда: они возвращают сюда новую
     разметку, и по ней тот же адрес открывается уже другим экраном. */
  return state === 'done'
    ? (
      <DonePage
        video={video} annotationId={annotation.annotation_id}
        onUnreviewed={setAnnotation}
      />
    )
    : (
      <ReviewPage
        video={video} annotationId={annotation.annotation_id}
        onReviewed={setAnnotation}
      />
    )
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<VideosPage />} />
        <Route path="/video/:id" element={<VideoRoute />} />
      </Routes>
    </BrowserRouter>
  )
}
