import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { IPC } from '../../src/shared/ipc'

describe('realtime renderer trust boundary', () => {
  it('exposes only the narrow SDP start/stop bridge', () => {
    expect(IPC.voice.realtimeStart).toBe('voice:realtime-start')
    expect(IPC.voice.realtimeStop).toBe('voice:realtime-stop')
    expect(IPC.voice.realtimeEvent).toBe('voice:realtime-event')
    expect(IPC.voice).not.toHaveProperty('mintRealtimeSession')
    expect(IPC.voice).not.toHaveProperty('setManualApiKey')
  })

  it('does not fetch credentials or override the app-server-owned session', () => {
    const source = readFileSync(
      resolve('src/renderer/src/features/voice/realtimeClient.ts'),
      'utf8'
    )
    expect(source).toContain("createDataChannel('oai-events')")
    expect(source).toContain('voice.realtimeStart')
    expect(source).not.toContain('session.update')
    expect(source).not.toContain('api.openai.com')
    expect(source).not.toContain('clientSecret')
  })
})
