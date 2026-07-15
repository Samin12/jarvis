import { describe, expect, it } from 'vitest'

import { appReducer, initialAppState, type AppState } from '../../src/renderer/src/state/appState'

function populatedState(accountId: string): AppState {
  return {
    ...initialAppState,
    auth: {
      state: 'signed_in',
      accountId,
      email: 'first@example.com',
      planType: 'plus'
    },
    coreMode: 'working',
    transcript: [{ id: 'message-1', role: 'user', text: 'private', at: 1 }],
    connectors: [
      {
        slug: 'gmail',
        title: 'Gmail',
        section: 'apps',
        status: 'connected'
      }
    ],
    codexTasks: [
      {
        taskId: 'task-1',
        threadId: 'thread-1',
        prompt: 'private task',
        state: 'running',
        startedAt: 1,
        events: []
      }
    ]
  }
}

describe('account-scoped renderer state', () => {
  it('clears sensitive HUD state immediately on sign-out', () => {
    const result = appReducer(populatedState('account-a'), {
      type: 'auth/set',
      status: { state: 'signed_out' }
    })

    expect(result).toMatchObject({
      auth: { state: 'signed_out' },
      coreMode: 'idle',
      transcript: [],
      connectors: [],
      codexTasks: []
    })
  })

  it('does not carry account A history into a different opaque account binding', () => {
    const result = appReducer(populatedState('account-a'), {
      type: 'auth/set',
      status: {
        state: 'signed_in',
        accountId: 'account-b',
        email: 'second@example.com',
        planType: 'plus'
      }
    })

    expect(result.transcript).toEqual([])
    expect(result.connectors).toEqual([])
    expect(result.codexTasks).toEqual([])
  })

  it('preserves current-account HUD state for a same-binding status refresh', () => {
    const current = populatedState('account-a')
    const result = appReducer(current, {
      type: 'auth/set',
      status: {
        state: 'signed_in',
        accountId: 'account-a',
        email: 'first@example.com',
        planType: 'plus'
      }
    })

    expect(result.transcript).toEqual(current.transcript)
    expect(result.connectors).toEqual(current.connectors)
    expect(result.codexTasks).toEqual(current.codexTasks)
  })
})
