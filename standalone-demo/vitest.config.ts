import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/demo-core/**/*.test.ts', 'src/demo/data/**/*.test.ts'], environment: 'node' },
});
