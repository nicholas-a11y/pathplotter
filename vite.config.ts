import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    proxy: {
      '/lightburn/api/': {
        target: 'http://127.0.0.1:19520',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/lightburn/, ''),
      },
    },
  },
})
