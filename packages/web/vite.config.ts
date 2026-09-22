import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { writeSeoPages } from './src/seo/ssg';

// 与 server 的 SB_PORT 保持一致（v1 占用 18791 时开发期可用 SB_PORT/SB_PROXY_TARGET 切换）
const apiTarget = process.env.SB_PROXY_TARGET ?? 'http://127.0.0.1:18791';

export default defineConfig({
  plugins: [
    react(),
    {
      // 词条长尾静态页：构建产物里多出一批 .html ＋ sitemap.xml（详见 docs/SEO-SPEC.md）
      name: 'sb-seo-static-pages',
      apply: 'build',
      closeBundle: {
        order: 'post',
        handler(this: { info(msg: string): void }) {
          // 走 Rollup 的 info 通道：构建日志要看得见，但不占 eslint 的 console 口径
          this.info(`sb-seo: ${writeSeoPages('dist').length} 个静态页（词条页 ＋ 目录页 ＋ sitemap.xml）`);
        },
      },
    },
  ],
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
