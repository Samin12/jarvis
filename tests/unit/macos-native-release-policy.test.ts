import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  classifyNativeEntitlements,
  isRestrictedNativeToolPath
} from '../../scripts/verify-macos-entitlements.mjs'

const app = '/tmp/Jarvis.app'

function entitlementKeys(relativePath: string): string[] {
  const plist = readFileSync(new URL(`../../build/${relativePath}`, import.meta.url), 'utf8')
  return [...plist.matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1]).sort()
}

describe('macOS native helper release policy', () => {
  it('assigns audio input only to the exact speech helper path', () => {
    const speech = join(app, 'Contents/Resources/native/macos-speech/arm64/jarvis-macos-speech')
    expect(classifyNativeEntitlements(app, speech)).toBe('speech')
    expect(isRestrictedNativeToolPath(app, speech)).toBe(true)
    expect(entitlementKeys('entitlements.mac.speech.plist')).toEqual([
      'com.apple.security.device.audio-input'
    ])
  })

  it('assigns empty tool entitlements to only the workspace helper and Codex trees', () => {
    const workspace = join(
      app,
      'Contents/Resources/native/macos-speech/x86_64/jarvis-workspace-helper'
    )
    const codex = join(
      app,
      'Contents/Resources/app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex'
    )
    expect(classifyNativeEntitlements(app, workspace)).toBe('tool')
    expect(classifyNativeEntitlements(app, codex)).toBe('tool')
    expect(entitlementKeys('entitlements.mac.tools.plist')).toEqual([])
  })

  it('does not grant a native profile to lookalikes, extra helpers, or escaping paths', () => {
    const candidates = [
      join(app, 'Contents/Resources/native/macos-speech/arm64/jarvis-macos-speech.backup'),
      join(app, 'Contents/Resources/native/macos-speech/arm64/unexpected-helper'),
      join(app, 'Contents/Resources/native/macos-speech/universal/jarvis-macos-speech'),
      join(app, '../jarvis-workspace-helper'),
      join(app, 'Contents/Resources/app.asar.unpacked/node_modules/@openai/not-codex/codex')
    ]
    for (const candidate of candidates) {
      expect(classifyNativeEntitlements(app, candidate), candidate).toBeNull()
      expect(isRestrictedNativeToolPath(app, candidate), candidate).toBe(false)
    }
  })
})
