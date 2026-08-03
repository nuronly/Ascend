// 用 vitest/config 的 defineConfig：它是 vite 的超集，额外接受 test 字段
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      // 走同源代理，httpOnly cookie 才能顺畅带上，也省掉本地 CORS 折腾
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
        // SSE 必须关闭代理缓冲，否则流式输出会被攒成一坨
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no'
            }
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // 图谱和画布只在部分页面用到，拆出去让首屏更轻
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          flow: ['@xyflow/react'],
          cytoscape: ['cytoscape'],
          markdown: ['react-markdown', 'remark-gfm', 'remark-math', 'rehype-katex', 'rehype-sanitize', 'katex'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    css: false,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
