import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // DB / render / e2e tests boot a real Postgres 16 container; contract tests
    // boot Prism and shell out to Schemathesis; the image tests run a real
    // codec over real (generated) image bytes. None of it is mocked.
    testTimeout: 120_000,
    hookTimeout: 240_000,
    // Fork pool: Testcontainers + child processes behave predictably here.
    pool: 'forks',
    reporters: ['verbose'],
    globalSetup: [],
  },
});
