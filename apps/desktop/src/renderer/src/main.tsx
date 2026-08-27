import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { isMockApi } from './api'
import { log } from './lib/log'
import './styles.css'

if (isMockApi())
  log.info('Running against the in-memory mock API (window.devMigration is not a complete bridge).')

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
