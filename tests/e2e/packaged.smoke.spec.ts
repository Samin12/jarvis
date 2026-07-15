import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

type PackagedTarget = {
  appPath: string
  executablePath: string
  label: string
}

function loadTargets(): PackagedTarget[] {
  const raw = process.env.JARVIS_PACKAGED_APP_TARGETS
  if (!raw) return []

  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('JARVIS_PACKAGED_APP_TARGETS must be a non-empty JSON array')
  }

  return value.map((target, index) => {
    if (
      !target ||
      typeof target !== 'object' ||
      typeof target.appPath !== 'string' ||
      typeof target.executablePath !== 'string' ||
      typeof target.label !== 'string'
    ) {
      throw new Error(`Invalid packaged target at index ${index}`)
    }
    return target as PackagedTarget
  })
}

const targets = loadTargets()

if (targets.length === 0) {
  test.skip('packaged app smoke requires an explicit packaged target', () => undefined)
}

for (const target of targets) {
  test(`fresh packaged ${target.label} opens the signed-out ChatGPT onboarding gate`, async () => {
    const testInfo = test.info()
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'jarvis-packaged-smoke-'))
    const home = join(fixtureRoot, 'home')
    const userData = join(fixtureRoot, 'user-data')
    const codexHome = join(fixtureRoot, 'codex-home')
    mkdirSync(home, { recursive: true })
    mkdirSync(userData, { recursive: true })
    mkdirSync(codexHome, { recursive: true })

    let application: ElectronApplication | null = null
    try {
      application = await electron.launch({
        executablePath: target.executablePath,
        args: [`--user-data-dir=${userData}`],
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
          LANG: process.env.LANG ?? 'en_US.UTF-8',
          CODEX_HOME: codexHome,
          OPENAI_API_KEY: '',
          COMPOSIO_API_KEY: '',
          ELECTRON_ENABLE_LOGGING: '1'
        }
      })

      const page = await application.firstWindow()
      const pageErrors: string[] = []
      page.on('pageerror', (error) => pageErrors.push(error.message))

      await expect(page.getByRole('heading', { name: 'JARVIS' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible()
      await expect(
        page.getByText('No API key · credentials stay with the local Codex service')
      ).toBeVisible()

      const status = await page.evaluate(async () => {
        const bridge = (
          window as typeof window & {
            jarvis?: {
              auth: { getStatus(): Promise<unknown> }
              voice: { laneAvailable(): Promise<unknown> }
            }
          }
        ).jarvis
        if (!bridge) throw new Error('Jarvis preload bridge was not installed')
        return {
          auth: await bridge.auth.getStatus(),
          voiceLane: await bridge.voice.laneAvailable()
        }
      })
      expect(status).toEqual({ auth: { state: 'signed_out' }, voiceLane: 'fallback' })

      const effectiveUserData = await application.evaluate(({ app }) => app.getPath('userData'))
      expect(realpathSync(effectiveUserData)).toBe(realpathSync(userData))
      expect(pageErrors).toEqual([])

      const screenshot = testInfo.outputPath('fresh-packaged-onboarding.png')
      await page.screenshot({ path: screenshot, fullPage: true })
      await testInfo.attach('fresh-packaged-onboarding', {
        path: screenshot,
        contentType: 'image/png'
      })
    } finally {
      try {
        if (application) await application.close()
      } finally {
        const parentAuthFileCreated = existsSync(join(codexHome, 'auth.json'))
        const isolatedAuthFileCreated = existsSync(join(userData, 'codex-home', 'auth.json'))
        rmSync(fixtureRoot, { recursive: true, force: true })
        expect(parentAuthFileCreated).toBe(false)
        expect(isolatedAuthFileCreated).toBe(false)
      }
    }
  })
}
