import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/app.css'
import { App } from './App'
import { installMock } from './mock/server'

// По умолчанию ничего не делает: фронт ходит в настоящий бэкенд. Мок ставит
// перехватчики только при VITE_USE_MOCK=1 — чтобы открыть UI без стека.
installMock()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
