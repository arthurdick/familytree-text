import { defineConfig } from 'vite';
import { resolve } from 'path';
import fs from 'fs';
import { marked } from 'marked';

// Configure marked for GitHub Flavored Markdown
marked.use({
  gfm: true,
  breaks: true
});

const markdownLoader = () => {
  return {
    name: 'markdown-loader',
    transformIndexHtml(html, ctx) {
      if (ctx.path.includes('spec.html')) {
        const specPath = resolve(__dirname, 'spec/ftt_spec_v0.1.md');
        
        try {
            const markdown = fs.readFileSync(specPath, 'utf-8');
            const content = marked.parse(markdown);
            
            const token = '__MARKDOWN_CONTENT__';
            const parts = html.split(token);

            if (parts.length === 2) {
                return parts[0] + content + parts[1];
            } else {
                console.warn(`[markdown-loader] Warning: Token '${token}' not found in ${ctx.path}. HTML content may have changed during build.`);
                return html;
            }
            
        } catch (err) {
            console.error("Error reading spec file:", err);
            return html;
        }
      }
      return html;
    }
  };
};

export default defineConfig({
  root: 'js',
  base: '/familytree-text/',
  plugins: [markdownLoader()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'js/index.html'),
        visualizer: resolve(__dirname, 'js/tools/visualizer.html'),
        relationship: resolve(__dirname, 'js/tools/relationship.html'),
        converter: resolve(__dirname, 'js/tools/converter.html'),
        spec: resolve(__dirname, 'js/spec.html'),
      },
    },
  },
});
