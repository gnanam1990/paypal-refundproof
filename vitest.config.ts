import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts', 'test/property/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/support/global-pg.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Each file owns a private cluster (own port and data dir) that it crashes and restarts.
        test: {
          name: 'restart',
          include: ['test/restart/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Runs the production build as a real process. Requires `pnpm build` first.
        test: {
          name: 'served',
          include: ['test/served/**/*.test.ts'],
          environment: 'node',
          testTimeout: 180_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
