import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// VITE_API_BASE — адрес бэкенда, куда прокси уводит /api. По умолчанию фронт
// работает на нём; мок (см. src/mock) включается явно, VITE_USE_MOCK=1.
const proxy = {
  '/api': { target: process.env.VITE_API_BASE ?? 'http://localhost:8000', changeOrigin: true },
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Vite сверяет заголовок Host и по умолчанию пускает только localhost —
    // защита от DNS rebinding. Через туннель это выглядит как «Blocked request».
    // Точка в начале означает домен и все его поддомены: на бесплатном ngrok
    // имя меняется при каждом перезапуске, и прибивать его гвоздями бессмысленно.
    // Свой домен добавляется через VITE_ALLOWED_HOSTS=a.example,b.example.
    allowedHosts: [
      '.ngrok-free.dev',
      '.ngrok-free.app',
      '.ngrok.io',
      '.trycloudflare.com',
      ...(process.env.VITE_ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean) ?? []),
    ],
    proxy,
  },
  // У preview своя секция: server.proxy на него не распространяется. Без этого
  // демо со сборки (npm run build && npm run preview) кладёт все запросы к
  // /api/v1 в 404, хотя в dev всё работает.
  preview: { proxy },
})
