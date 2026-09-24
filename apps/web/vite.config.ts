import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Share validation schemas and types with the backend, straight from source.
      '@erp/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    // Same-origin API in development, as behind Nginx in production, so the refresh cookie works.
    proxy: {
      '/api': { target: process.env.GATEWAY_URL ?? 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'jsdom',
  },
});
