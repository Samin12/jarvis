/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  classifyNativeEntitlements,
  verifyMacOSEntitlementBoundaries
} from './verify-macos-entitlements.mjs'

const require = createRequire(import.meta.url)
const { signAsync } = require('@electron/osx-sign')
const { retry } = require('builder-util')
const toolEntitlements = fileURLToPath(
  new URL('../build/entitlements.mac.tools.plist', import.meta.url)
)
const speechEntitlements = fileURLToPath(
  new URL('../build/entitlements.mac.speech.plist', import.meta.url)
)

export default async function macosSign(options) {
  if (process.platform !== 'darwin') throw new Error('macOS signing must run on macOS')
  for (const entitlementPath of [speechEntitlements, toolEntitlements]) {
    const info = lstatSync(entitlementPath)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Missing physical native entitlements file: ${entitlementPath}`)
    }
  }

  const appPath = resolve(options.app)
  const inheritedOptionsForFile = options.optionsForFile
  const optionsForFile = (filePath) => {
    const inherited = inheritedOptionsForFile?.(filePath) ?? {}
    const classification = classifyNativeEntitlements(appPath, filePath)
    if (classification === 'speech') {
      return { ...inherited, entitlements: speechEntitlements }
    }
    if (classification === 'tool') {
      return { ...inherited, entitlements: toolEntitlements }
    }
    return inherited
  }

  await retry(() => signAsync({ ...options, optionsForFile }), {
    retries: 3,
    interval: 5_000,
    backoff: 5_000
  })
  const summary = verifyMacOSEntitlementBoundaries(appPath)
  console.log(
    JSON.stringify(
      {
        signingPolicy: 'speech audio-only; workspace and Codex empty',
        nativeToolCount: summary.speechTools.length,
        codexToolCount: summary.codexTools.length
      },
      null,
      2
    )
  )
}
