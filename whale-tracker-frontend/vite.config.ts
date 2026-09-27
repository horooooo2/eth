import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');
  /** 本地开发默认代理到本机后端；连线上可设 VITE_API_PROXY_TARGET=http://43.160.208.168 */
  const apiTarget = (process.env.VITE_API_PROXY_TARGET || env.VITE_API_PROXY_TARGET || 'http://127.0.0.1').replace(/\/$/, '');
  const wsTarget = apiTarget.replace(/^http/i, 'ws');

  return {
    plugins: [
      vue(),
      ...(command === 'serve' ? [{
        name: 'tradfi-range-core-dev-esm-interop',
        enforce: 'pre' as const,
        transform(code: string, id: string) {
          if (!id.replace(/[?#].*$/, '').endsWith('/whale-tracker-backend/lib/tradfiRangeCore.cjs')) return null;
          return { code: `${code}\nexport default globalThis.TradfiRangeCore;`, map: null };
        },
      }] : []),
    ],
    base: './',
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@core': fileURLToPath(new URL('../whale-tracker-backend/lib', import.meta.url)),
      },
    },
    server: {
      port: 5273,
      fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          /** SSE 诊币流可能超过默认代理超时 */
          timeout: 0,
          proxyTimeout: 0,
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
