import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // The server port comes from PORT in the root .env
  const env = loadEnv(mode, '..', '')

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': `http://localhost:${env.PORT}`,
      },
    },
  }
})
