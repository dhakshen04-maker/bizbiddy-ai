import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

class AppErrorBoundary extends Component {
  state = { hasError: false, message: '' }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error, info) {
    console.error('BizBuddy failed while rendering.', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <main role="alert" style={{ minHeight: '100vh', display: 'grid', placeContent: 'center', gap: 12, padding: 24, color: '#17211d', fontFamily: 'sans-serif' }}>
          <h1 style={{ margin: 0 }}>BizBuddy could not load this screen.</h1>
          <p style={{ margin: 0 }}>Refresh the page to try again. The error has been recorded in the browser console.</p>
          {import.meta.env.DEV && <pre style={{ maxWidth: 720, whiteSpace: 'pre-wrap' }}>{this.state.message}</pre>}
          <button type="button" onClick={() => window.location.reload()} style={{ justifySelf: 'start', padding: '10px 16px' }}>Refresh</button>
        </main>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
