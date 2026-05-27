import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 7702,
    proxy: {
      '/api': {
        target: 'http://localhost:7710',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist'
  }
})
