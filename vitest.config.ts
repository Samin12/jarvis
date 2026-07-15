import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'node_modules/.cache/jarvis-coverage',
      reporter: ['text', 'json-summary', 'lcov', 'html'],
      include: [
        'src/main/security/ipc.ts',
        'src/main/security/urlPolicy.ts',
        'src/main/services/actions/approvalBroker.ts',
        'src/main/services/actions/canonical.ts',
        'src/main/services/actions/policy.ts',
        'src/main/services/appServer/environment.ts',
        'src/main/services/appServer/jsonLines.ts'
      ],
      thresholds: {
        statements: 60,
        branches: 55,
        functions: 65,
        lines: 60
      }
    }
  }
})
