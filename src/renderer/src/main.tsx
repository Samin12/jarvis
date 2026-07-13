// fonts — Big Shoulders (display numerals/wordmark) + Martian Mono (chrome)
import '@fontsource/big-shoulders/300.css'
import '@fontsource/big-shoulders/400.css'
import '@fontsource/big-shoulders/500.css'
import '@fontsource/big-shoulders/600.css'
import '@fontsource/martian-mono/400.css'
import '@fontsource/martian-mono/500.css'
import './styles/globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AppStateProvider } from './state/appState'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStateProvider>
      <App />
    </AppStateProvider>
  </StrictMode>
)
