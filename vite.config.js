import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { chatHandler, statusHandler } from './server/chat-api.js'

function assistantApi() {
  const attachRoutes = (server) => {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url || '/', 'http://localhost').pathname
      if (path === '/api/chat') {
        chatHandler(request, response).catch(() => {
          if (!response.headersSent) {
            response.statusCode = 500
            response.setHeader('Content-Type', 'application/json; charset=utf-8')
            response.end(JSON.stringify({ error: 'The chat service encountered an unexpected error.' }))
          }
        })
        return
      }
      if (path === '/api/status') {
        statusHandler(request, response)
        return
      }
      next()
    })
  }

  return {
    name: 'bizbuddy-assistant-api',
    config(_config, { mode }) {
      const serverEnv = loadEnv(mode, process.cwd(), '')
      for (const name of ['AI_API_URL', 'AI_API_KEY', 'AI_MODEL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) {
        if (serverEnv[name] !== undefined) process.env[name] = serverEnv[name]
      }
    },
    configureServer: attachRoutes,
    configurePreviewServer: attachRoutes,
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [assistantApi(), react()],
})
