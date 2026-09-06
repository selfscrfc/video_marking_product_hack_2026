/* Печатает выгрузку мока в stdout, чтобы прогнать её через настоящую
   JSON Schema. Требование кейса — 100 % валидных файлов; проверяется оно
   схемой, а не аккуратностью. */
import { seed } from '../mock/data'
import { exportBody, toCsv } from '../mock/server'

const state = seed()
const mode = process.argv[2] ?? 'json'
const out = state.annotations.map((ann) => {
  const video = state.videos.find((v) => v.video_id === ann.video_id)!
  const stem = video.filename.replace(/\.[^.]+$/, '')
  return mode === 'csv' ? toCsv(ann, stem) : exportBody(ann, stem)
})
console.log(mode === 'csv' ? out.join('\n') : JSON.stringify(out, null, 2))
