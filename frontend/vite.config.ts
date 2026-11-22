import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev: the Rust API runs on :8080 (or KANB_API); Vite proxies /api (incl. WebSockets) so cookies stay same-origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.KANB_API ?? 'http://127.0.0.1:8080', ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 1500 },
})
