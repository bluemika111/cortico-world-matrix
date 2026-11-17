import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { CORTICO_LANGUAGE: 'zh' },
    testTimeout: 20000,
    // 这台机器上 Node 24 的子进程 worker 启动即崩（V8 "Re-embedded builtins"），
    // 线程池用 worker_threads，不受影响。
    pool: 'threads',
  },
});
