import { defineConfig } from 'vitest/config';


export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
});
