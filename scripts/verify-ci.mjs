import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const checks = [
  ['trusted release configuration', 'verify:release-config'],
  ['format', 'format:check'],
  ['lint', 'lint'],
  ['typecheck', 'typecheck'],
  ['unit + coverage', 'test:coverage'],
  ['native speech protocol', 'test:native'],
  ['production build', 'build'],
  ['fresh-profile Electron smoke', 'verify:smoke']
]

const failures = []
for (const [label, script] of checks) {
  console.log(`\n[verify] ${label}: npm run ${script}`)
  const result = spawnSync(npm, ['run', script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit'
  })
  if (result.error || result.status !== 0) {
    failures.push({ label, script, status: result.status, error: result.error?.message })
  }
}

console.log('\n[verify] summary')
const summary = []
for (const [label, script] of checks) {
  const failed = failures.some((failure) => failure.script === script)
  console.log(`  ${failed ? 'FAIL' : 'PASS'}  ${label}`)
  summary.push({ label, script, status: failed ? 'failed' : 'passed' })
}

const evidenceDirectory = resolve('node_modules/.cache')
mkdirSync(evidenceDirectory, { recursive: true })
writeFileSync(
  resolve(evidenceDirectory, 'jarvis-verification-summary.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), checks: summary }, null, 2)}\n`,
  'utf8'
)

if (failures.length > 0) {
  console.error(`\n${failures.length} verification gate${failures.length === 1 ? '' : 's'} failed.`)
  process.exit(1)
}

console.log('\nAll verification gates passed.')
