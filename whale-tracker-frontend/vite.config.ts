import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  /** 本地开发默认代理到线上；本机后端可在 .env.development.local 设 VITE_API_PROXY_TARGET=http://127.0.0.1 */
  const apiTarget = (env.VITE_API_PROXY_TARGET || 'http://43.143.207.156').replace(/\/$/, '');
  const wsTarget = apiTarget.replace(/^http/i, 'ws');

  return {
    plugins: [vue()],
    base: './',
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/poly-fed': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/realtime': {
          target: wsTarget,
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});
