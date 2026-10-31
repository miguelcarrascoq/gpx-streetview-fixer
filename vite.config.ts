import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/gpx-streetview-fixer/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 43123,
  },
})
