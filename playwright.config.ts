import { defineConfig } from '@playwright/test'

const packagedSmoke = Boolean(process.env.JARVIS_PACKAGED_APP_TARGETS)

export default defineConfig({
  testDir: 'tests/e2e',
  testIgnore: packagedSmoke ? /electron\.smoke\.spec\.ts$/ : /packaged\.smoke\.spec\.ts$/,
  outputDir: process.env.JARVIS_PLAYWRIGHT_OUTPUT_DIR ?? 'node_modules/.cache/playwright-results',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: {
    timeout: 20_000
  },
  reporter: packagedSmoke
    ? [['line']]
    : process.env.CI
      ? [
          ['line'],
          ['html', { outputFolder: 'node_modules/.cache/playwright-report', open: 'never' }]
        ]
      : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  }
})
