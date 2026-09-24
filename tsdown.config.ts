import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    budget: 'src/budget.ts',
  },
  format: ['esm'],
  dts: true,
  // Every package in the harness monorepo emits to `lib`, which is what the
  // published `main` and `exports` fields point at.
  outDir: 'lib',
  // The harness packages and zod are peer dependencies shared with the running
  // host, so they are never bundled into the published output.
  external: [/^@deepseek-ai\//, /^zod(\/|$)/],
})
