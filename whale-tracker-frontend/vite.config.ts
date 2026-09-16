import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  /** 本地开发默认代理到本机后端；连线上可设 VITE_API_PROXY_TARGET=http://43.160.208.168 */
  const apiTarget = (process.env.VITE_API_PROXY_TARGET || env.VITE_API_PROXY_TARGET || 'http://127.0.0.1').replace(/\/$/, '');
  const wsTarget = apiTarget.replace(/^http/i, 'ws');
  const aiTraderTarget = (
    process.env.VITE_AI_TRADER_PROXY ||
    env.VITE_AI_TRADER_PROXY ||
    'http://127.0.0.1:8000'
  ).replace(/\/$/, '');

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
        '/ai-api': {
          target: aiTraderTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/ai-api/, '/api'),
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
