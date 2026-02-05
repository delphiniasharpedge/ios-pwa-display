import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      // Proxy /sse to the remo-e SSE server (avoids CORS issues)
      '/sse': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sse/, '/events'),
      },
    },
  },
});
