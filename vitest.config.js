// vitest.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Explicitly point to the test files
    include: ['implementations/js/tests/**/*.test.js'],
    
    // Ensure the root is set to the main project folder, not 'web'
    root: '.', 
  },
});
