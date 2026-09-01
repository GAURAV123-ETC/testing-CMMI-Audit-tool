import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, open: true },
  resolve: {
    alias: {
      '@tabler/icons-react': path.resolve('./node_modules/@tabler/icons-react/dist/cjs/tabler-icons-react.cjs')
    }
  }
})
