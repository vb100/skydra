import { defineConfig } from 'vitest/config';

// Integration tests need a real PostgreSQL (TEST_DATABASE_URL, superuser). Each test file creates
// and drops its own database.
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
