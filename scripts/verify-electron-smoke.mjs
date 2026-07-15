import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const entryPoint = resolve('out/main/index.js')
if (!existsSync(entryPoint)) {
  console.error(
    `Electron smoke test requires a compiled app at ${entryPoint}. Run npm run build first.`
  )
  process.exit(1)
}

const playwrightBin = resolve(
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'playwright.cmd' : 'playwright'
)
if (!existsSync(playwrightBin)) {
  console.error('Playwright is not installed. Run npm ci before the smoke test.')
  process.exit(1)
}

const result = spawnSync(playwrightBin, ['test', '--config', 'playwright.config.ts'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit'
})

if (result.error) {
  console.error(`Unable to start Playwright: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
