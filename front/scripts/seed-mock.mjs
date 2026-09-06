// Кладёт настоящие ролики в public/mock, чтобы мок работал на реальном видео,
// а не на заглушках. Файлы не коммитятся (см. .gitignore).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clips = resolve(here, '../../../hyp0/clips')
const out = resolve(here, '../public/mock')

const WANTED = ['asm_static_00.mp4', 'asm_static_02.mp4']

mkdirSync(out, { recursive: true })
let copied = 0
for (const name of WANTED) {
  const from = resolve(clips, name)
  if (!existsSync(from)) {
    console.warn(`нет ${from} — мок покажет заглушку вместо видео`)
    continue
  }
  copyFileSync(from, resolve(out, name))
  copied++
}
console.log(copied ? `скопировано роликов: ${copied}` : 'ролики не найдены, мок останется с заглушками')
