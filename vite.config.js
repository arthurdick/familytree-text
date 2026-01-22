import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'js',
  base: '/familytree-text/', 
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'js/index.html'),
        visualizer: resolve(__dirname, 'js/tools/visualizer.html'),
        relationship: resolve(__dirname, 'js/tools/relationship.html'),
      },
    },
  },
});
