import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// The Express server (server.js) serves web/dist in production and answers
// /api; in dev, Vite serves the app and proxies /api, the feed and the
// legacy v1 page to it.
const API = process.env.VANTAGE_API || 'http://127.0.0.1:3000'; // the server listens on loopback (HOST)

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/legacy': API,
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
