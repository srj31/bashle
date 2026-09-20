import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // json-summary is what CI reads for the badge; lcov is for local HTML.
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      // The display layer imports `vscode`, which only exists inside an
      // extension host, so these files cannot be exercised from vitest at all.
      // Counting them would report unreachable lines as untested.
      exclude: ['src/extension.ts', 'src/decorations.ts', 'src/panel.ts'],
      reportsDirectory: 'coverage',
    },
  },
});
