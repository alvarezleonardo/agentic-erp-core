import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'examples/*/tests/**/*.test.ts', 'tests/**/*.test.ts', 'evals/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
