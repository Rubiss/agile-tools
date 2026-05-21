import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { createWorkspacePackageAliases } from './tests/support/workspace-package-aliases';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nextDir = path.resolve(__dirname, 'apps/web/node_modules/next');

export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    alias: [
      ...createWorkspacePackageAliases(__dirname),
      {
        find: '@',
        replacement: path.resolve(__dirname, 'apps/web/src'),
      },
      {
        find: 'next/navigation',
        replacement: path.join(nextDir, 'navigation.js'),
      },
    ],
  },
  test: {
    // Unit tests live alongside source files (*.test.ts, *.spec.ts)
    include: ['packages/*/src/**/*.{test,spec}.{ts,tsx}', 'apps/*/src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/**'],
    setupFiles: ['apps/web/src/test/setup.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.d.ts', '**/dist/**'],
    },
  },
});
