import { defineConfig } from 'vite';
import { resolve } from 'path';
import fs from 'fs';
import { marked } from 'marked';

marked.use({ gfm: true, breaks: true });

const markdownLoader = () => {
  return {
    name: 'markdown-loader',
    transformIndexHtml(html, ctx) {
      if (ctx.path.includes('spec.html')) {
        const specPath = resolve(__dirname, 'spec/ftt_spec_v0.1.md');
        const markdown = fs.readFileSync(specPath, 'utf-8');
        const content = marked.parse(markdown);
        return html.replace('__MARKDOWN_CONTENT__', content);
      }
      return html;
    }
  };
};

export default defineConfig({
  root: 'web',
  base: '/familytree-text/', 
  plugins: [markdownLoader()],
  build: {
    outDir: '../dist', // Since root is 'web', we go up one level to put 'dist' in the project root
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'web/index.html'),
        visualizer: resolve(__dirname, 'web/tools/visualizer.html'),
        relationship: resolve(__dirname, 'web/tools/relationship.html'),
        converter: resolve(__dirname, 'web/tools/converter.html'),
        spec: resolve(__dirname, 'web/spec.html'),
      },
    },
  },
});
