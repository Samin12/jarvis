import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

const require = createRequire(resolve('package.json'))
const electronPath = require('electron') as string

test('fresh profile opens the ChatGPT onboarding gate without real credentials', async () => {
  const testInfo = test.info()
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'jarvis-electron-smoke-'))
  const userData = join(fixtureRoot, 'user-data')
  const codexHome = join(fixtureRoot, 'codex-home')
  mkdirSync(userData, { recursive: true })
  mkdirSync(codexHome, { recursive: true })

  let application: ElectronApplication | null = null
  try {
    application = await electron.launch({
      executablePath: electronPath,
      args: [resolve('out/main/index.js'), `--user-data-dir=${userData}`],
      env: {
        ...process.env,
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
    expect(existsSync(join(userData, 'codex-home', 'auth.json'))).toBe(false)
    expect(existsSync(join(codexHome, 'auth.json'))).toBe(false)
    expect(pageErrors).toEqual([])

    const screenshot = testInfo.outputPath('fresh-profile-onboarding.png')
    await page.screenshot({ path: screenshot, fullPage: true })
    await testInfo.attach('fresh-profile-onboarding', {
      path: screenshot,
      contentType: 'image/png'
    })
  } finally {
    if (application) await application.close()
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('signed-in HUD exposes apps, Codex, voice controls, and typed conversation', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'jarvis-electron-hud-'))
  const userData = join(fixtureRoot, 'user-data')
  const codexHome = join(fixtureRoot, 'codex-home')
  mkdirSync(userData, { recursive: true })
  mkdirSync(codexHome, { recursive: true })

  let application: ElectronApplication | null = null
  try {
    application = await electron.launch({
      executablePath: electronPath,
      args: [resolve('out/main/index.js'), `--user-data-dir=${userData}`],
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: '',
        COMPOSIO_API_KEY: '',
        ELECTRON_ENABLE_LOGGING: '1'
      }
    })

    const page = await application.firstWindow()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible()

    await application.evaluate(({ BrowserWindow, ipcMain }) => {
      const replace = (channel: string, handler: (...args: unknown[]) => unknown): void => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }
      replace('connectors:list', () => [
        {
          slug: 'gmail',
          title: 'Gmail',
          section: 'apps',
          status: 'connected',
          detail: 'qa@example.com'
        },
        {
          slug: 'calendar',
          title: 'Google Calendar',
          section: 'apps',
          status: 'disconnected'
        }
      ])
      replace('voice:lane-available', () => 'fallback')
      replace(
        'voice:local-status',
        () =>
          new Promise<'ready'>((resolveStatus) => {
            ;(
              globalThis as typeof globalThis & {
                __jarvisResolveLocalStatus?: () => void
              }
            ).__jarvisResolveLocalStatus = () => resolveStatus('ready')
          })
      )
      replace('voice:local-permission', () => 'ready')
      replace('voice:local-start', () => undefined)
      replace('voice:local-stop', () => undefined)
      replace('voice:local-cancel', () => undefined)
      replace('voice:local-speak', () => undefined)
      replace('voice:local-stop-speaking', () => undefined)
      replace('codex:list', () => [])
      replace('codex:login-status', () => ({ loggedIn: true, taskEligible: true }))
      replace('codex:receipts', () => [])
      replace('core:cancel', () => undefined)
      replace('core:send', (_event, payload) => {
        const request = payload as { requestId: string }
        const window = BrowserWindow.getAllWindows()[0]
        setTimeout(() => {
          window?.webContents.send('core:delta', {
            requestId: request.requestId,
            kind: 'text_delta',
            text: 'Good morning. Your private desktop core is ready.'
          })
          window?.webContents.send('core:delta', {
            requestId: request.requestId,
            kind: 'done'
          })
        }, 10)
      })

      BrowserWindow.getAllWindows()[0]?.webContents.send('auth:status-changed', {
        state: 'signed_in',
        email: 'qa@example.com',
        planType: 'plus',
        accountId: 'qa-account-binding'
      })
    })

    await expect(page.getByRole('region', { name: 'Jarvis ready when you are' })).toBeVisible()
    await expect(page.getByText('qa@example.com').first()).toBeVisible()
    await expect(page.getByRole('region', { name: 'Connectors' })).toContainText('Gmail')
    await expect(page.getByRole('region', { name: 'Connectors' })).toContainText('Google Calendar')
    await expect(page.getByRole('region', { name: 'Codex tasks' })).toBeVisible()
    const rightEdgeLayout = await page.evaluate(() => {
      const width = window.innerWidth
      return [...document.querySelectorAll<HTMLElement>('.cx-panel, .codex-panel')].map(
        (element) => {
          const rect = element.getBoundingClientRect()
          return { left: rect.left, right: rect.right, width, scrollWidth: element.scrollWidth }
        }
      )
    })
    expect(rightEdgeLayout).toHaveLength(2)
    for (const box of rightEdgeLayout) {
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(box.width)
      expect(box.scrollWidth).toBeLessThanOrEqual(Math.ceil(box.right - box.left))
    }

    await page.getByRole('button', { name: 'Engage' }).click()
    await expect(page.getByRole('button', { name: 'Cancel voice startup' })).toBeVisible()
    await application.evaluate(() => {
      const mainGlobal = globalThis as typeof globalThis & {
        __jarvisResolveLocalStatus?: () => void
      }
      const resolveStatus = mainGlobal.__jarvisResolveLocalStatus
      delete mainGlobal.__jarvisResolveLocalStatus
      if (!resolveStatus) throw new Error('Voice startup did not request local status')
      resolveStatus()
    })
    const prompt = page.getByRole('textbox', { name: 'Message Jarvis' })
    await expect(prompt).toBeVisible()
    await prompt.fill('Good morning Jarvis')
    await prompt.press('Enter')

    await expect(page.getByText('Good morning Jarvis', { exact: true })).toBeVisible()
    await expect(
      page.getByText('Good morning. Your private desktop core is ready.', { exact: true })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stand down' })).toBeVisible()
    expect(pageErrors).toEqual([])
    expect(existsSync(join(codexHome, 'auth.json'))).toBe(false)
    expect(existsSync(join(userData, 'codex-home', 'auth.json'))).toBe(false)

    // A new opaque account capability must remount every hook-local HUD state
    // owner. In particular, a live voice client and its transcript must not
    // survive into another verified ChatGPT account.
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('auth:status-changed', {
        state: 'signed_in',
        email: 'other@example.com',
        planType: 'plus',
        accountId: 'other-account-binding'
      })
    })
    await expect(page.getByText('other@example.com').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Engage' })).toBeVisible()
    await expect(page.getByText('Good morning Jarvis', { exact: true })).toHaveCount(0)
    await expect(
      page.getByText('Good morning. Your private desktop core is ready.', { exact: true })
    ).toHaveCount(0)

    await application.evaluate(({ BrowserWindow, ipcMain }) => {
      ipcMain.removeHandler('codex:login-status')
      ipcMain.handle('codex:login-status', () => ({ loggedIn: true, taskEligible: false }))
      BrowserWindow.getAllWindows()[0]?.webContents.send('auth:status-changed', {
        state: 'signed_in',
        email: 'workspace@example.com',
        planType: 'business',
        accountId: 'workspace-account-binding'
      })
    })
    await expect(
      page.getByText(
        'Verified folder tasks require an eligible personal ChatGPT account. Chat and Apps still work.',
        { exact: true }
      )
    ).toBeVisible()
    await expect(page.getByRole('button', { name: /WORKSPACE CHOOSE FOLDER/i })).toBeDisabled()
    await expect(page.getByRole('textbox', { name: 'Codex task' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'RUN' })).toBeDisabled()
    expect(pageErrors).toEqual([])
  } finally {
    if (application) await application.close()
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
