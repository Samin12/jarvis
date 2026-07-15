import { describe, expect, it } from 'vitest'

import { JarvisCoreService } from '../../src/main/services/core'
import type { AppServerState, JarvisAppServer, PlanType } from '../../src/main/services/appServer'

type NotificationListener = (event: { params: unknown; generation: string }) => void

class FakeAppServer {
  state: AppServerState = 'ready'
  generation: string | null = 'generation-1'
  restartCount = 0
  account: { type: 'chatgpt'; email: string | null; planType: PlanType } | null = null
  readonly requests: Array<{ method: string; params: unknown }> = []
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>
  private readonly notificationListeners = new Map<string, Set<NotificationListener>>()
  private readonly lifecycleListeners = new Set<(event: unknown) => void>()

  subscribe(method: string, listener: NotificationListener): () => void {
    const listeners = this.notificationListeners.get(method) ?? new Set<NotificationListener>()
    listeners.add(listener)
    this.notificationListeners.set(method, listeners)
    return () => listeners.delete(listener)
  }

  onLifecycle(listener: (event: unknown) => void): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  emit(method: string, params: unknown, generation = this.generation ?? 'generation-1'): void {
    for (const listener of this.notificationListeners.get(method) ?? []) {
      listener({ params, generation })
    }
  }

  async start(): Promise<unknown> {
    return { generation: this.generation }
  }

  async restart(reason: string): Promise<unknown> {
    const previousGeneration = this.generation
    this.restartCount += 1
    this.state = 'stopping'
    for (const listener of this.lifecycleListeners) {
      listener({ kind: 'restarting', previousGeneration, reason })
    }
    this.generation = `generation-${this.restartCount + 1}`
    this.state = 'ready'
    return { generation: this.generation }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params })
    if (this.onRequest) {
      const custom = await this.onRequest(method, params)
      if (custom !== undefined) return custom
    }
    switch (method) {
      case 'account/read':
        return { account: this.account, requiresOpenaiAuth: true }
      case 'app/list':
        return { data: [], nextCursor: null }
      case 'thread/start':
        return { thread: { id: 'thread-1' } }
      default:
        return {}
    }
  }
}

function makeCore(
  fake: FakeAppServer,
  realtimeStartTimeoutMs = 100,
  openExternal: (url: string) => Promise<void> = async () => undefined
): JarvisCoreService {
  return new JarvisCoreService({
    appServer: fake as unknown as JarvisAppServer,
    conversationCwd: '/tmp/jarvis-core-test',
    resolvePrincipalId: async (email) => (email ? `principal:${email.toLowerCase()}` : null),
    openExternal,
    realtimeStartTimeoutMs
  })
}

async function signedInCore(
  realtimeStartTimeoutMs = 100
): Promise<{ fake: FakeAppServer; core: JarvisCoreService }> {
  const fake = new FakeAppServer()
  fake.account = { type: 'chatgpt', email: 'operator@example.com', planType: 'plus' }
  const core = makeCore(fake, realtimeStartTimeoutMs)
  await core.initialize()
  return { fake, core }
}

describe('ChatGPT-authenticated realtime core', () => {
  it('rotates session authority but keeps the durable principal on same-account updates', async () => {
    const { fake, core } = await signedInCore()
    const firstSession = core.getAccountBinding()
    const firstPrincipal = core.getPrincipalId()
    fake.account = { type: 'chatgpt', email: 'OPERATOR@example.com', planType: 'pro' }

    fake.emit('account/updated', { authMode: 'chatgpt', planType: 'pro' })
    await waitUntil(() => core.getAccountBinding() !== firstSession)

    expect(core.getPrincipalId()).toBe(firstPrincipal)
    expect(core.getStatus()).toMatchObject({ state: 'signed_in', planType: 'pro' })
  })

  it('allows read-only use but exposes no mutation principal for an ambiguous workspace account', async () => {
    const fake = new FakeAppServer()
    fake.account = { type: 'chatgpt', email: 'operator@example.com', planType: 'business' }
    const core = new JarvisCoreService({
      appServer: fake as unknown as JarvisAppServer,
      conversationCwd: '/tmp/jarvis-core-test',
      resolvePrincipalId: async () => null,
      openExternal: async () => undefined
    })

    await expect(core.initialize()).resolves.toMatchObject({ state: 'signed_in' })
    expect(core.getPrincipalId()).toBeNull()
    expect(core.getComputerActionBinding('thread-1', 'turn-1')).toBeNull()
  })

  it('serializes rapid sign-in and reopen requests into one provider login', async () => {
    const fake = new FakeAppServer()
    const opened: string[] = []
    const core = makeCore(fake, 100, async (url) => {
      opened.push(url)
    })
    await core.initialize()
    fake.onRequest = (method) => {
      if (method === 'account/login/start') {
        return {
          type: 'chatgpt',
          loginId: 'login-serialized',
          authUrl: 'https://auth.openai.com/authorize?client_id=test'
        }
      }
      return undefined
    }

    const first = core.signIn()
    await waitUntil(() => opened.length === 1)
    const reopened = core.signIn()
    await waitUntil(() => opened.length === 2)

    expect(reopened).toBe(first)
    expect(
      fake.requests.filter((request) => request.method === 'account/login/start')
    ).toHaveLength(1)

    await core.cancelSignIn()
    await expect(first).resolves.toEqual({ state: 'signed_out' })
  })

  it('cancels a login that was still starting before its provider id arrived', async () => {
    const fake = new FakeAppServer()
    const start = deferredValue<{
      type: 'chatgpt'
      loginId: string
      authUrl: string
    }>()
    const opened: string[] = []
    const core = makeCore(fake, 100, async (url) => {
      opened.push(url)
    })
    await core.initialize()
    fake.onRequest = (method) => {
      if (method === 'account/login/start') return start.promise
      if (method === 'account/login/cancel') return { status: 'canceled' }
      return undefined
    }

    const pending = core.signIn()
    await waitUntil(() => fake.requests.some((request) => request.method === 'account/login/start'))
    await core.cancelSignIn()
    start.resolve({
      type: 'chatgpt',
      loginId: 'late-login',
      authUrl: 'https://auth.openai.com/authorize?client_id=test'
    })

    await expect(pending).resolves.toEqual({ state: 'signed_out' })
    expect(opened).toEqual([])
    expect(fake.requests).toContainEqual({
      method: 'account/login/cancel',
      params: { loginId: 'late-login' }
    })
    expect(core.getStatus()).toEqual({ state: 'signed_out' })
  })

  it('cancels provider state when the system browser cannot be opened', async () => {
    const fake = new FakeAppServer()
    const core = makeCore(fake, 100, async () => {
      throw new Error('browser unavailable')
    })
    await core.initialize()
    fake.onRequest = (method) => {
      if (method === 'account/login/start') {
        return {
          type: 'chatgpt',
          loginId: 'browser-failure',
          authUrl: 'https://auth.openai.com/authorize?client_id=test'
        }
      }
      if (method === 'account/login/cancel') return { status: 'canceled' }
      return undefined
    }

    await expect(core.signIn()).resolves.toEqual({
      state: 'error',
      message: 'browser unavailable'
    })
    expect(fake.requests).toContainEqual({
      method: 'account/login/cancel',
      params: { loginId: 'browser-failure' }
    })
    expect(core.getStatus()).toEqual({ state: 'error', message: 'browser unavailable' })
  })

  it('keeps cancellation authoritative while a completed login is being secured', async () => {
    const fake = new FakeAppServer()
    const accountRead = deferredValue<{
      account: { type: 'chatgpt'; email: string; planType: 'plus' }
      requiresOpenaiAuth: true
    }>()
    const core = makeCore(fake)
    await core.initialize()
    fake.onRequest = (method) => {
      if (method === 'account/login/start') {
        return {
          type: 'chatgpt',
          loginId: 'securing-login',
          authUrl: 'https://auth.openai.com/authorize?client_id=test'
        }
      }
      if (method === 'account/read') return accountRead.promise
      if (method === 'account/login/cancel') return { status: 'canceled' }
      if (method === 'account/logout') return {}
      return undefined
    }

    const pending = core.signIn()
    await waitUntil(() => {
      const status = core.getStatus()
      return status.state === 'authorizing' && status.phase === 'waiting_for_approval'
    })
    fake.emit('account/login/completed', {
      loginId: 'securing-login',
      success: true,
      error: null
    })
    await waitUntil(() => {
      const status = core.getStatus()
      return status.state === 'authorizing' && status.phase === 'securing_session'
    })

    await core.cancelSignIn()
    accountRead.resolve({
      account: { type: 'chatgpt', email: 'operator@example.com', planType: 'plus' },
      requiresOpenaiAuth: true
    })

    await expect(pending).resolves.toEqual({ state: 'signed_out' })
    await waitUntil(() => fake.requests.some((request) => request.method === 'account/logout'))
    expect(core.getStatus()).toEqual({ state: 'signed_out' })
    expect(core.getAccountBinding()).toBeNull()
  })

  it('does not let a stale cancelled login log out a newer completed login', async () => {
    const fake = new FakeAppServer()
    const core = makeCore(fake)
    await core.initialize()
    const staleRead = deferredValue<{
      account: { type: 'chatgpt'; email: string; planType: 'plus' }
      requiresOpenaiAuth: true
    }>()
    let loginStarts = 0
    let accountReads = 0
    fake.onRequest = (method) => {
      if (method === 'account/login/start') {
        loginStarts += 1
        return {
          type: 'chatgpt',
          loginId: loginStarts === 1 ? 'login-a' : 'login-b',
          authUrl: 'https://auth.openai.com/authorize?client_id=test'
        }
      }
      if (method === 'account/read') {
        accountReads += 1
        if (accountReads === 1) return staleRead.promise
        return {
          account: { type: 'chatgpt', email: 'new@example.com', planType: 'plus' },
          requiresOpenaiAuth: true
        }
      }
      if (method === 'account/login/cancel' || method === 'account/logout') return {}
      return undefined
    }

    const first = core.signIn()
    await waitUntil(() => {
      const status = core.getStatus()
      return status.state === 'authorizing' && status.loginId === 'login-a'
    })
    fake.emit('account/login/completed', { loginId: 'login-a', success: true, error: null })
    await waitUntil(() => accountReads === 1)
    await core.cancelSignIn()
    await expect(first).resolves.toEqual({ state: 'signed_out' })
    const logoutsAfterCancel = fake.requests.filter(
      (request) => request.method === 'account/logout'
    ).length

    const second = core.signIn()
    await waitUntil(() => {
      const status = core.getStatus()
      return status.state === 'authorizing' && status.loginId === 'login-b'
    })
    fake.emit('account/login/completed', { loginId: 'login-b', success: true, error: null })
    await expect(second).resolves.toMatchObject({ state: 'signed_in', email: 'new@example.com' })
    const binding = core.getAccountBinding()

    staleRead.resolve({
      account: { type: 'chatgpt', email: 'old@example.com', planType: 'plus' },
      requiresOpenaiAuth: true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(core.getStatus()).toMatchObject({ state: 'signed_in', email: 'new@example.com' })
    expect(core.getAccountBinding()).toBe(binding)
    expect(fake.requests.filter((request) => request.method === 'account/logout')).toHaveLength(
      logoutsAfterCancel
    )
  })

  it('cancels an in-flight browser login and ignores a late completion', async () => {
    const fake = new FakeAppServer()
    const core = makeCore(fake)
    await core.initialize()
    fake.onRequest = (method) => {
      if (method === 'account/login/start') {
        return {
          type: 'chatgpt',
          loginId: 'login-1',
          authUrl: 'https://auth.openai.com/authorize?client_id=test'
        }
      }
      if (method === 'account/login/cancel') return { status: 'canceled' }
      return undefined
    }

    const pending = core.signIn()
    await waitUntil(() => {
      const status = core.getStatus()
      return status.state === 'authorizing' && status.phase === 'waiting_for_approval'
    })

    await core.cancelSignIn()
    await expect(pending).resolves.toEqual({ state: 'signed_out' })
    expect(fake.requests).toContainEqual({
      method: 'account/login/cancel',
      params: { loginId: 'login-1' }
    })

    fake.emit('account/login/completed', { loginId: 'login-1', success: true, error: null })
    await Promise.resolve()
    expect(core.getStatus()).toEqual({ state: 'signed_out' })
  })

  it('reports realtime unavailable while signed out and available after ChatGPT sign-in', async () => {
    const signedOutFake = new FakeAppServer()
    const signedOut = makeCore(signedOutFake)
    await signedOut.initialize()
    expect(signedOut.canStartRealtime()).toBe(false)

    const { core } = await signedInCore()
    expect(core.canStartRealtime()).toBe(true)
  })

  it('restarts a failed local core and recovers an existing ChatGPT session on retry', async () => {
    const { fake, core } = await signedInCore()
    const opened: string[] = []
    const recovering = makeCore(fake, 100, async (url) => {
      opened.push(url)
    })
    await recovering.initialize()

    fake.state = 'failed'
    const status = await recovering.signIn()

    expect(fake.restartCount).toBe(1)
    expect(status.state).toBe('signed_in')
    expect(recovering.getAccountBinding()).not.toBeNull()
    expect(opened).toEqual([])
    expect(
      fake.requests.filter((request) => request.method === 'account/login/start')
    ).toHaveLength(0)
    expect(core.getStatus().state).toBe('checking')
    expect(core.getAccountBinding()).toBeNull()
  })

  it('restarts a failed local core before beginning a new browser login', async () => {
    const fake = new FakeAppServer()
    const opened: string[] = []
    const core = makeCore(fake, 100, async (url) => {
      opened.push(url)
    })
    await core.initialize()
    fake.onRequest = (method) => {
      if (method === 'account/login/start') {
        return {
          type: 'chatgpt',
          loginId: 'login-after-restart',
          authUrl: 'https://auth.openai.com/authorize?client_id=test'
        }
      }
      return undefined
    }
    fake.state = 'failed'

    const pending = core.signIn()
    await waitUntil(() => opened.length === 1)

    expect(fake.restartCount).toBe(1)
    expect(fake.requests.some((request) => request.method === 'account/read')).toBe(true)
    expect(fake.requests.some((request) => request.method === 'account/login/start')).toBe(true)
    await core.cancelSignIn()
    await expect(pending).resolves.toEqual({ state: 'signed_out' })
  })

  it('uses an opaque account binding and rotates it on every account update', async () => {
    const { fake, core } = await signedInCore()
    const first = core.getAccountBinding()

    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    fake.emit('account/updated', {})
    await waitUntil(
      () => core.getStatus().state === 'signed_in' && core.getAccountBinding() !== first
    )

    const second = core.getAccountBinding()
    expect(second).toMatch(/^[0-9a-f-]{36}$/)
    expect(second).not.toBe(first)
  })

  it('withholds account authority when a session refresh cannot be verified', async () => {
    const { fake, core } = await signedInCore()
    expect(core.getAccountBinding()).not.toBeNull()
    fake.onRequest = (method) => {
      if (method === 'account/read') throw new Error('session refresh failed')
      return undefined
    }

    fake.emit('account/updated', {})
    await waitUntil(() => core.getStatus().state === 'error')

    expect(core.getStatus()).toEqual({ state: 'error', message: 'session refresh failed' })
    expect(core.getAccountBinding()).toBeNull()
  })

  it('revokes local authority even when provider logout fails', async () => {
    const { fake, core } = await signedInCore()
    fake.onRequest = (method) => {
      if (method === 'account/logout') throw new Error('provider logout unavailable')
      return undefined
    }

    await expect(core.signOut()).rejects.toThrow('provider logout unavailable')

    expect(core.getStatus()).toEqual({ state: 'signed_out' })
    expect(core.getAccountBinding()).toBeNull()
    expect(core.listApps()).toEqual([])
    expect(core.canStartRealtime()).toBe(false)
  })

  it('uses latest-wins account refreshes and ignores an older signed-in response', async () => {
    const { fake, core } = await signedInCore()
    const older = deferredValue<{
      account: { type: 'chatgpt'; email: string; planType: 'plus' }
      requiresOpenaiAuth: true
    }>()
    const newer = deferredValue<{ account: null; requiresOpenaiAuth: true }>()
    let reads = 0
    fake.onRequest = (method) => {
      if (method !== 'account/read') return undefined
      reads += 1
      return reads === 1 ? older.promise : newer.promise
    }

    fake.emit('account/updated', {})
    fake.emit('account/updated', {})
    await waitUntil(() => reads === 2)
    newer.resolve({ account: null, requiresOpenaiAuth: true })
    await waitUntil(() => core.getStatus().state === 'signed_out')
    older.resolve({
      account: { type: 'chatgpt', email: 'stale@example.com', planType: 'plus' },
      requiresOpenaiAuth: true
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(core.getStatus()).toEqual({ state: 'signed_out' })
    expect(core.getAccountBinding()).toBeNull()
  })

  it('does not let a pending account refresh resurrect authority after sign-out', async () => {
    const { fake, core } = await signedInCore()
    const pendingRead = deferredValue<{
      account: { type: 'chatgpt'; email: string; planType: 'plus' }
      requiresOpenaiAuth: true
    }>()
    fake.onRequest = (method) => {
      if (method === 'account/read') return pendingRead.promise
      return undefined
    }

    fake.emit('account/updated', {})
    await waitUntil(
      () => fake.requests.filter((request) => request.method === 'account/read').length === 2
    )
    await core.signOut()
    pendingRead.resolve({
      account: { type: 'chatgpt', email: 'stale@example.com', planType: 'plus' },
      requiresOpenaiAuth: true
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(core.getStatus()).toEqual({ state: 'signed_out' })
    expect(core.getAccountBinding()).toBeNull()
  })

  it('keeps explicit sign-out authoritative against later account notifications', async () => {
    const { fake, core } = await signedInCore()
    const logout = deferredValue<Record<string, never>>()
    const readsBefore = fake.requests.filter((request) => request.method === 'account/read').length
    fake.onRequest = (method) => {
      if (method === 'account/logout') return logout.promise
      return undefined
    }

    const signingOut = core.signOut()
    await waitUntil(() => fake.requests.some((request) => request.method === 'account/logout'))
    fake.emit('account/updated', {})
    await Promise.resolve()
    expect(fake.requests.filter((request) => request.method === 'account/read')).toHaveLength(
      readsBefore
    )

    logout.resolve({})
    await signingOut
    fake.emit('account/updated', {})
    await Promise.resolve()

    expect(core.getStatus()).toEqual({ state: 'signed_out' })
    expect(core.getAccountBinding()).toBeNull()
    expect(fake.requests.filter((request) => request.method === 'account/read')).toHaveLength(
      readsBefore
    )
  })

  it('waits for every overlapping logout before allowing a new login', async () => {
    const { fake, core } = await signedInCore()
    const firstLogout = deferredValue<Record<string, never>>()
    const secondLogout = deferredValue<Record<string, never>>()
    let logoutCalls = 0
    fake.onRequest = (method) => {
      if (method === 'account/logout') {
        logoutCalls += 1
        if (logoutCalls === 1) return firstLogout.promise
        if (logoutCalls === 2) return secondLogout.promise
        return {}
      }
      if (method === 'account/login/start') {
        return {
          type: 'chatgpt',
          loginId: 'after-all-logouts',
          authUrl: 'https://auth.openai.com/authorize?client_id=test'
        }
      }
      return undefined
    }

    const first = core.signOut()
    await waitUntil(() => logoutCalls === 1)
    const second = core.signOut()
    await waitUntil(() => logoutCalls === 2)
    const signingIn = core.signIn()

    secondLogout.resolve({})
    await second
    await Promise.resolve()
    expect(fake.requests.some((request) => request.method === 'account/login/start')).toBe(false)

    firstLogout.resolve({})
    await first
    await waitUntil(() => fake.requests.some((request) => request.method === 'account/login/start'))
    await core.cancelSignIn()
    await expect(signingIn).resolves.toEqual({ state: 'signed_out' })
  })

  it('drops stale app-list responses and notifications across sign-out', async () => {
    const { fake, core } = await signedInCore()
    const page = deferredValue<{
      data: ReturnType<typeof appFixture>[]
      nextCursor: null
    }>()
    fake.onRequest = (method) => {
      if (method === 'app/list') return page.promise
      return undefined
    }

    const refreshing = core.refreshApps(true)
    await waitUntil(
      () => fake.requests.filter((request) => request.method === 'app/list').length >= 2
    )
    await core.signOut()
    page.resolve({ data: [appFixture()], nextCursor: null })

    await expect(refreshing).resolves.toEqual([])
    fake.emit('app/list/updated', { data: [appFixture()] })
    await Promise.resolve()
    expect(core.listApps()).toEqual([])
  })

  it('reserves text sends before thread creation so rapid calls cannot cross-wire', async () => {
    const { fake, core } = await signedInCore()
    const thread = deferredValue<{ thread: { id: string } }>()
    fake.onRequest = (method) => {
      if (method === 'thread/start') return thread.promise
      if (method === 'turn/start') return { turn: { id: 'turn-first' } }
      return undefined
    }

    const first = core.send({ requestId: 'first', text: 'first message' })
    await waitUntil(() => fake.requests.some((request) => request.method === 'thread/start'))
    await expect(core.send({ requestId: 'second', text: 'second message' })).rejects.toThrow(
      'already answering'
    )
    thread.resolve({ thread: { id: 'thread-first' } })
    await first

    expect(fake.requests.filter((request) => request.method === 'thread/start')).toHaveLength(1)
    expect(fake.requests.filter((request) => request.method === 'turn/start')).toEqual([
      {
        method: 'turn/start',
        params: expect.objectContaining({
          threadId: 'thread-first',
          input: expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: 'first message' })
          ])
        })
      }
    ])
  })

  it('rejects realtime before provider work while a text lane is starting', async () => {
    const { fake, core } = await signedInCore()
    const thread = deferredValue<{ thread: { id: string } }>()
    fake.onRequest = (method) => {
      if (method === 'thread/start') return thread.promise
      if (method === 'turn/start') return { turn: { id: 'turn-text' } }
      return undefined
    }

    const sending = core.send({ requestId: 'text-first', text: 'hello' })
    await waitUntil(() => fake.requests.some((request) => request.method === 'thread/start'))
    await expect(
      core.startRealtime({ requestId: 'voice-second', offerSdp: 'v=offer\r\n' })
    ).rejects.toThrow('already answering')
    expect(fake.requests.some((request) => request.method === 'thread/realtime/start')).toBe(false)

    thread.resolve({ thread: { id: 'thread-text' } })
    await sending
  })

  it('rejects text before provider work while the realtime lane is starting', async () => {
    const { fake, core } = await signedInCore()
    const thread = deferredValue<{ thread: { id: string } }>()
    fake.onRequest = (method) => {
      if (method === 'thread/start') return thread.promise
      return undefined
    }

    const starting = core.startRealtime({ requestId: 'voice-first', offerSdp: 'v=offer\r\n' })
    await waitUntil(() => fake.requests.some((request) => request.method === 'thread/start'))
    await expect(core.send({ requestId: 'text-second', text: 'hello' })).rejects.toThrow(
      'already answering'
    )
    expect(fake.requests.some((request) => request.method === 'turn/start')).toBe(false)

    await core.stopRealtime({ requestId: 'voice-first' })
    thread.resolve({ thread: { id: 'thread-voice' } })
    await expect(starting).rejects.toThrow('context changed')
    expect(fake.requests.some((request) => request.method === 'thread/realtime/start')).toBe(false)
  })

  it('cancels a text send that is still waiting for its assistant thread', async () => {
    const { fake, core } = await signedInCore()
    const thread = deferredValue<{ thread: { id: string } }>()
    fake.onRequest = (method) => {
      if (method === 'thread/start') return thread.promise
      return undefined
    }

    const sending = core.send({ requestId: 'pending-thread', text: 'do not start this' })
    await waitUntil(() => fake.requests.some((request) => request.method === 'thread/start'))
    await core.cancel('pending-thread')
    thread.resolve({ thread: { id: 'cancelled-thread' } })
    await sending

    expect(fake.requests.some((request) => request.method === 'turn/start')).toBe(false)
  })

  it('interrupts a turn returned after cancellation during turn startup', async () => {
    const { fake, core } = await signedInCore()
    const turn = deferredValue<{ turn: { id: string } }>()
    fake.onRequest = (method) => {
      if (method === 'turn/start') return turn.promise
      return undefined
    }

    const sending = core.send({ requestId: 'pending-turn', text: 'stop this turn' })
    await waitUntil(() => fake.requests.some((request) => request.method === 'turn/start'))
    await core.cancel('pending-turn')
    turn.resolve({ turn: { id: 'cancelled-turn' } })
    await sending

    expect(fake.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'cancelled-turn' }
    })
  })

  it('interrupts provider work when an account refresh cannot be verified', async () => {
    const { fake, core } = await signedInCore()
    fake.onRequest = (method) => {
      if (method === 'turn/start') return { turn: { id: 'turn-active' } }
      return undefined
    }
    await core.send({ requestId: 'active', text: 'keep working' })
    fake.onRequest = (method) => {
      if (method === 'account/read') throw new Error('session refresh failed')
      return undefined
    }

    fake.emit('account/updated', {})
    await waitUntil(() => core.getStatus().state === 'error')
    await waitUntil(() =>
      fake.requests.some(
        (request) =>
          request.method === 'turn/interrupt' &&
          JSON.stringify(request.params) ===
            JSON.stringify({ threadId: 'thread-1', turnId: 'turn-active' })
      )
    )

    expect(core.getAccountBinding()).toBeNull()
  })

  it('starts WebRTC through the pinned app-server and correlates started plus SDP notifications', async () => {
    const { fake, core } = await signedInCore()
    fake.onRequest = (method) => {
      if (method === 'thread/realtime/start') {
        queueMicrotask(() => {
          fake.emit('thread/realtime/started', {
            threadId: 'thread-1',
            realtimeSessionId: 'backend-session',
            version: 'v1'
          })
          fake.emit('thread/realtime/sdp', { threadId: 'thread-1', sdp: 'v=answer\r\n' })
        })
      }
      return undefined
    }

    const result = await core.startRealtime({
      requestId: 'renderer-request',
      offerSdp: 'v=offer\r\n'
    })

    expect(result).toMatchObject({
      requestId: 'renderer-request',
      answerSdp: 'v=answer\r\n'
    })
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/)

    const threadStart = fake.requests.find((request) => request.method === 'thread/start')
    expect(threadStart?.params).toMatchObject({
      permissions: 'jarvis_assistant',
      runtimeWorkspaceRoots: [],
      environments: [],
      config: {
        'features.shell_tool': false,
        'features.unified_exec': false,
        'features.multi_agent': false,
        'features.browser_use': false,
        'features.browser_use_external': false,
        'features.computer_use': false,
        'features.image_generation': false,
        web_search: 'disabled',
        'features.realtime_conversation': true,
        'apps._default.enabled': true,
        'apps._default.destructive_enabled': false,
        'apps._default.open_world_enabled': false,
        'apps._default.default_tools_approval_mode': 'writes'
      },
      dynamicTools: [
        {
          type: 'namespace',
          name: 'jarvis_codex',
          tools: [
            {
              type: 'function',
              name: 'dispatch_task',
              deferLoading: false,
              inputSchema: {
                type: 'object',
                required: ['prompt'],
                additionalProperties: false,
                properties: {
                  prompt: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 32_000
                  }
                }
              }
            }
          ]
        },
        {
          type: 'namespace',
          name: 'jarvis_computer',
          tools: [
            {
              type: 'function',
              name: 'open_application',
              deferLoading: false,
              inputSchema: {
                type: 'object',
                required: ['appId'],
                additionalProperties: false
              }
            }
          ]
        }
      ]
    })
    expect(threadStart?.params).not.toHaveProperty('sandbox')
    const realtimeStart = fake.requests.find(
      (request) => request.method === 'thread/realtime/start'
    )
    expect(realtimeStart?.params).toMatchObject({
      threadId: 'thread-1',
      outputModality: 'audio',
      includeStartupContext: true,
      transport: { type: 'webrtc', sdp: 'v=offer\r\n' }
    })

    await core.stopRealtime({ requestId: result.requestId, sessionId: result.sessionId })
    expect(fake.requests.some((request) => request.method === 'thread/realtime/stop')).toBe(true)
  })

  it('binds computer actions only to a live turn on the signed-in assistant thread', async () => {
    const { fake, core } = await signedInCore()
    fake.onRequest = (method) => {
      if (method === 'thread/realtime/start') {
        queueMicrotask(() => {
          fake.emit('thread/realtime/started', {
            threadId: 'thread-1',
            realtimeSessionId: 'backend-session',
            version: 'v1'
          })
          fake.emit('thread/realtime/sdp', { threadId: 'thread-1', sdp: 'v=answer\r\n' })
        })
      }
      return undefined
    }
    const session = await core.startRealtime({
      requestId: 'binding-request',
      offerSdp: 'v=offer\r\n'
    })

    fake.emit('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-action' }
    })
    expect(core.getComputerActionBinding('thread-1', 'turn-action')).toEqual({
      processEpoch: 'generation-1',
      accountId: core.getAccountBinding(),
      principalId: 'principal:operator@example.com',
      providerGeneration: 'generation-1',
      threadId: 'thread-1',
      turnId: 'turn-action'
    })
    expect(core.getAssistantActionBinding('thread-1', 'turn-action')).toEqual(
      core.getComputerActionBinding('thread-1', 'turn-action')
    )
    expect(core.getComputerActionBinding('thread-1', 'other-turn')).toBeNull()
    expect(core.getComputerActionBinding('other-thread', 'turn-action')).toBeNull()

    fake.emit('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-action', status: 'completed' }
    })
    expect(core.getComputerActionBinding('thread-1', 'turn-action')).toBeNull()
    await core.stopRealtime({ requestId: session.requestId, sessionId: session.sessionId })
  })

  it('revokes a text turn computer binding before awaiting provider interruption', async () => {
    const { fake, core } = await signedInCore()
    fake.onRequest = (method) => {
      if (method === 'turn/start') return { turn: { id: 'turn-text' } }
      return undefined
    }
    await core.send({ requestId: 'text-request', text: 'open Calculator' })
    fake.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-text' } })
    expect(core.getComputerActionBinding('thread-1', 'turn-text')).not.toBeNull()

    const interrupted = deferredValue<Record<string, never>>()
    fake.onRequest = (method) => {
      if (method === 'turn/interrupt') return interrupted.promise
      return undefined
    }
    const cancelling = core.cancel('text-request')
    expect(core.getComputerActionBinding('thread-1', 'turn-text')).toBeNull()
    interrupted.resolve({})
    await cancelling
  })

  it('serializes realtime reconnect and ignores a delayed close from the old thread', async () => {
    const { fake, core } = await signedInCore()
    const firstStop = deferredValue<Record<string, never>>()
    let threadNumber = 0
    fake.onRequest = (method, params) => {
      if (method === 'thread/start') {
        threadNumber += 1
        return { thread: { id: `thread-${threadNumber}` } }
      }
      if (method === 'thread/realtime/start') {
        const threadId = (params as { threadId: string }).threadId
        queueMicrotask(() => {
          fake.emit('thread/realtime/started', {
            threadId,
            realtimeSessionId: `session-${threadId}`,
            version: 'v1'
          })
          fake.emit('thread/realtime/sdp', { threadId, sdp: 'v=answer\r\n' })
        })
      }
      if (
        method === 'thread/realtime/stop' &&
        (params as { threadId: string }).threadId === 'thread-1'
      ) {
        return firstStop.promise
      }
      return undefined
    }

    const first = await core.startRealtime({ requestId: 'first-live', offerSdp: 'v=offer\r\n' })
    fake.emit('turn/started', { threadId: 'thread-1', turn: { id: 'old-live-turn' } })
    expect(core.getComputerActionBinding('thread-1', 'old-live-turn')).not.toBeNull()
    const stopping = core.stopRealtime({
      requestId: first.requestId,
      sessionId: first.sessionId
    })
    expect(core.getComputerActionBinding('thread-1', 'old-live-turn')).toBeNull()
    fake.emit('turn/started', { threadId: 'thread-1', turn: { id: 'late-old-turn' } })
    expect(core.getComputerActionBinding('thread-1', 'late-old-turn')).toBeNull()
    await waitUntil(() =>
      fake.requests.some(
        (request) =>
          request.method === 'turn/interrupt' &&
          JSON.stringify(request.params) ===
            JSON.stringify({ threadId: 'thread-1', turnId: 'late-old-turn' })
      )
    )
    await waitUntil(() =>
      fake.requests.some(
        (request) =>
          request.method === 'thread/realtime/stop' &&
          (request.params as { threadId: string }).threadId === 'thread-1'
      )
    )
    const reconnecting = core.startRealtime({
      requestId: 'second-live',
      offerSdp: 'v=offer\r\n'
    })
    await Promise.resolve()
    expect(fake.requests.filter((request) => request.method === 'thread/start')).toHaveLength(1)

    firstStop.resolve({})
    await stopping
    const second = await reconnecting
    fake.emit('thread/realtime/closed', { threadId: 'thread-1', reason: 'late_old_close' })
    await core.stopRealtime({ requestId: second.requestId, sessionId: second.sessionId })

    expect(
      fake.requests
        .filter((request) => request.method === 'thread/realtime/stop')
        .map((request) => (request.params as { threadId: string }).threadId)
    ).toEqual(['thread-1', 'thread-2'])
  })

  it('interrupts live assistant work when the provider closes realtime naturally', async () => {
    const { fake, core } = await signedInCore()
    fake.onRequest = (method) => {
      if (method === 'thread/realtime/start') {
        queueMicrotask(() => {
          fake.emit('thread/realtime/started', {
            threadId: 'thread-1',
            realtimeSessionId: 'backend-session',
            version: 'v1'
          })
          fake.emit('thread/realtime/sdp', { threadId: 'thread-1', sdp: 'v=answer\r\n' })
        })
      }
      return undefined
    }

    await core.startRealtime({ requestId: 'natural-close', offerSdp: 'v=offer\r\n' })
    fake.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-live' } })
    fake.emit('thread/realtime/closed', { threadId: 'thread-1', reason: 'transport_closed' })

    await waitUntil(() =>
      fake.requests.some(
        (request) =>
          request.method === 'turn/interrupt' &&
          JSON.stringify(request.params) ===
            JSON.stringify({ threadId: 'thread-1', turnId: 'turn-live' })
      )
    )
    expect(core.getComputerActionBinding('thread-1', 'turn-live')).toBeNull()
  })

  it('interrupts live assistant work when the account signs out', async () => {
    const { fake, core } = await signedInCore()
    fake.onRequest = (method) => {
      if (method === 'thread/realtime/start') {
        queueMicrotask(() => {
          fake.emit('thread/realtime/started', {
            threadId: 'thread-1',
            realtimeSessionId: 'backend-session',
            version: 'v1'
          })
          fake.emit('thread/realtime/sdp', { threadId: 'thread-1', sdp: 'v=answer\r\n' })
        })
      }
      return undefined
    }

    await core.startRealtime({ requestId: 'logout-live', offerSdp: 'v=offer\r\n' })
    fake.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-live-logout' } })
    await core.signOut()

    expect(fake.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-live-logout' }
    })
    expect(core.getComputerActionBinding('thread-1', 'turn-live-logout')).toBeNull()
  })

  it('ignores unrelated notifications and times out closed when the matching SDP never arrives', async () => {
    const { fake, core } = await signedInCore(20)
    fake.onRequest = (method) => {
      if (method === 'thread/realtime/start') {
        queueMicrotask(() => {
          fake.emit('thread/realtime/started', {
            threadId: 'other-thread',
            realtimeSessionId: null,
            version: 'v1'
          })
          fake.emit('thread/realtime/sdp', { threadId: 'other-thread', sdp: 'v=answer\r\n' })
        })
      }
      return undefined
    }

    await expect(
      core.startRealtime({ requestId: 'timeout-request', offerSdp: 'v=offer\r\n' })
    ).rejects.toThrow('timed out')
    expect(fake.requests.some((request) => request.method === 'thread/realtime/stop')).toBe(true)
  })

  it('cancels an in-flight start by renderer request id and rejects the pending invocation', async () => {
    const { fake, core } = await signedInCore(1_000)
    fake.onRequest = (method) => {
      if (method === 'thread/realtime/start') return new Promise(() => undefined)
      return undefined
    }

    const pending = core.startRealtime({
      requestId: 'cancel-request',
      offerSdp: 'v=offer\r\n'
    })
    await waitUntil(() =>
      fake.requests.some((request) => request.method === 'thread/realtime/start')
    )
    await core.stopRealtime({ requestId: 'cancel-request' })

    await expect(pending).rejects.toThrow('client_stop')
    expect(fake.requests.some((request) => request.method === 'thread/realtime/stop')).toBe(true)
  })
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_500
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for fake request')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function deferredValue<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function appFixture(): {
  id: string
  name: string
  description: null
  logoUrl: null
  logoUrlDark: null
  iconAssets: null
  iconDarkAssets: null
  distributionChannel: null
  branding: null
  appMetadata: null
  labels: null
  installUrl: string
  isAccessible: boolean
  isEnabled: boolean
  pluginDisplayNames: never[]
} {
  return {
    id: 'stale-gmail',
    name: 'Gmail',
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    iconAssets: null,
    iconDarkAssets: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: 'https://chatgpt.com/apps/gmail',
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: []
  }
}
