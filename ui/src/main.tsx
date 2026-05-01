import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const rootElement = document.getElementById('root')
if (!rootElement) {
  // index.html ships with `<div id="root">` — if it's missing, the page
  // is broken in a way that warrants a hard failure rather than a silent
  // mount into nothing.
  throw new Error('Root element #root not found')
}
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
