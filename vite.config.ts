/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// base './' makes every asset URL relative, so the build works at
// https://<user>.github.io/<any-repo-name>/ without configuration.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          return undefined;
        },
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
