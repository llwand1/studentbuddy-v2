import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 与 server 的 SB_PORT 保持一致（v1 占用 18791 时开发期可用 SB_PORT/SB_PROXY_TARGET 切换）
const apiTarget = process.env.SB_PROXY_TARGET ?? 'http://127.0.0.1:18791';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': apiTarget,
    },
  },
  build: {
    outDir: 'dist',
  },
});
