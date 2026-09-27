import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx'],
    // 固定测试时区为东八区：时间格式化类用例（chat-meta / chat-export 等）断言的是
    // 「本地时刻」，写死了 +8 的结果。GitHub Actions runner 是 UTC，不钉死就会
    // 出现「本地全绿、CI 必红」——曾经 run 12/13/14 连续挂在这一条上。
    // 钉死后本机与 CI 行为一致，套件结果可复现。
    env: {
      TZ: 'Asia/Shanghai',
    },
  },
});
