import { join } from 'node:path'
import {
  app,
  dialog,
  safeStorage,
  shell,
  type BrowserWindow,
  type IpcMain,
  type OpenDialogOptions
} from 'electron'
import { IPC } from '../../../shared/ipc'
import type {
  CodexDispatchRequest,
  ConversationSendRequest,
  HostApprovalPreview
} from '../../../shared/types'
import { assertPlainObject, registerTrustedHandler, requireString } from '../../security'
import { ActionCoordinator, ActionLedger } from '../actions'
import { createJarvisAppServer, preparePrivateDirectory, type JarvisAppServer } from '../appServer'
import { AccountPrincipalStore, JarvisCoreService } from '../core'
import { ComputerActionService } from '../computer'
import { JarvisTaskService, NativeWorkspaceWriter, WorkspaceGrantRegistry } from '../tasks'

export interface JarvisRuntime {
  appServer: JarvisAppServer
  core: JarvisCoreService
  tasks: JarvisTaskService
  actions: ActionCoordinator
  computer: ComputerActionService
  start(): Promise<void>
  stop(): Promise<void>
}

export async function createJarvisRuntime(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null
): Promise<JarvisRuntime> {
  const ledger = new ActionLedger(join(app.getPath('userData'), 'data', 'action-ledger.sqlite3'))
  const actions = new ActionCoordinator(ledger)
  const principalStore = new AccountPrincipalStore({
    path: join(app.getPath('userData'), 'data', 'account-principal.key'),
    protector: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plaintext) => safeStorage.encryptString(plaintext),
      decrypt: (ciphertext) => safeStorage.decryptString(ciphertext)
    },
    hasPrincipalHistory: () => ledger.hasPrincipalHistory()
  })
  const workspaceGrants = new WorkspaceGrantRegistry([app.getPath('userData')])
  const assistantScratch = await preparePrivateDirectory(
    join(app.getPath('userData'), 'assistant-scratch'),
    'Jarvis assistant scratch directory'
  )
  let tasks: JarvisTaskService | null = null
  let core: JarvisCoreService | null = null
  let computer: ComputerActionService | null = null
  const appServer = await createJarvisAppServer({
    resolution: {
      isPackaged: app.isPackaged,
      appRoot: app.isPackaged ? app.getAppPath() : process.cwd(),
      resourcesPath: process.resourcesPath
    },
    codexHome: join(app.getPath('userData'), 'codex-home'),
    client: { name: 'jarvis', title: 'Jarvis', version: app.getVersion() },
    handlers: {
      'item/commandExecution/requestApproval': () => ({ decision: 'decline' }),
      'item/fileChange/requestApproval': () => ({ decision: 'decline' }),
      'item/tool/call': (params, context) => {
        const taskResult = tasks?.handleToolCall(params, context) ?? null
        if (taskResult) return taskResult
        const binding = core?.getAssistantActionBinding(params.threadId, params.turnId) ?? null
        const assistantTaskResult = tasks?.handleAssistantToolCall(params, {
          rpcId: String(context.requestId),
          generation: context.generation,
          binding,
          currentBinding: () =>
            core?.getAssistantActionBinding(params.threadId, params.turnId) ?? null,
          signal: context.signal
        })
        if (assistantTaskResult) return assistantTaskResult
        if (!computer || !binding) {
          return {
            contentItems: [
              {
                type: 'inputText',
                text: 'The host rejected this computer action because its trusted context is no longer current.'
              }
            ],
            success: false
          }
        }
        return computer.handleToolCall(params, {
          rpcId: String(context.requestId),
          binding,
          currentBinding: () =>
            core?.getAssistantActionBinding(params.threadId, params.turnId) ?? null,
          signal: context.signal
        })
      }
    },
    logger: {
      warn: (message) => console.warn('[app-server]', message),
      error: (message) => console.error('[app-server]', message)
    }
  })
  const coreService = new JarvisCoreService({
    appServer,
    conversationCwd: assistantScratch,
    resolvePrincipalId: (email, planType) => principalStore.resolve(email, planType),
    openExternal: async (url) => {
      await shell.openExternal(url)
    }
  })
  core = coreService
  const computerService = new ComputerActionService({ actions })
  computer = computerService
  const workspaceWriter = new NativeWorkspaceWriter({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectRoot: process.cwd(),
    architecture: process.arch,
    configuration: 'release'
  })
  tasks = new JarvisTaskService({
    appServer,
    actions,
    workspaceWriter,
    accountBinding: () => coreService.getAccountBinding(),
    principalBinding: () => coreService.getPrincipalId()
  })

  registerCoreIpc(ipcMain, getWindow, coreService, tasks, workspaceGrants, actions, appServer)

  let lastAccountId: string | null = null
  coreService.onStatus((status) => {
    const nextAccountId = status.state === 'signed_in' ? status.accountId : null
    if (lastAccountId && nextAccountId !== lastAccountId) {
      actions.invalidateAll('account_context_changed')
      workspaceGrants.clear()
      tasks?.clearActiveWorkspace()
      tasks?.retireAssistantDispatches()
      void tasks?.cancelAll('account_context_changed').catch(() => undefined)
    }
    lastAccountId = nextAccountId
    send(getWindow, IPC.auth.statusChanged, status)
  })
  coreService.onApps((apps) => send(getWindow, IPC.connectors.changed, apps))
  coreService.onDelta((delta) => send(getWindow, IPC.core.delta, delta))
  tasks.onTask((task) => send(getWindow, IPC.codex.taskChanged, task))
  tasks.onEvent((taskId, row) => send(getWindow, IPC.codex.event, { taskId, row }))
  actions.onApprovalsChanged((approvals) =>
    send(getWindow, IPC.approvals.changed, approvals satisfies HostApprovalPreview[])
  )

  return {
    appServer,
    core: coreService,
    tasks,
    actions,
    computer: computerService,
    start: async () => {
      // A prior process may have died after dispatching a mutation but before
      // persisting its outcome. Recover those attempts before any provider or
      // account session can accept new work, and record exactly-once
      // unknown-outcome receipts in the same SQLite transaction.
      actions.recoverInterruptedWrites()
      await coreService.initialize()
    },
    stop: async () => {
      let failure: unknown = null
      try {
        await tasks.cancelAll('application_quit')
      } catch (error) {
        failure = error
      }
      try {
        actions.invalidateAll('application_quit')
        workspaceGrants.clear()
        tasks.clearActiveWorkspace()
      } catch (error) {
        failure ??= error
      }
      try {
        await appServer.stop()
      } catch (error) {
        failure ??= error
      } finally {
        ledger.close()
      }
      if (failure) throw failure
    }
  }
}

function registerCoreIpc(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
  core: JarvisCoreService,
  tasks: JarvisTaskService,
  workspaceGrants: WorkspaceGrantRegistry,
  actions: ActionCoordinator,
  appServer: JarvisAppServer
): void {
  registerTrustedHandler(ipcMain, IPC.auth.getStatus, getWindow, () => core.getStatus())
  registerTrustedHandler(ipcMain, IPC.auth.signIn, getWindow, () => core.signIn())
  registerTrustedHandler(ipcMain, IPC.auth.cancelSignIn, getWindow, () => core.cancelSignIn())
  registerTrustedHandler(ipcMain, IPC.auth.signOut, getWindow, async () => {
    // signOut revokes local account authority synchronously before its first
    // provider await. Start it first so a slow Codex interrupt cannot leave
    // the signed-in capability usable during logout.
    const signingOut = core.signOut()
    actions.invalidateAll('account_logout')
    workspaceGrants.clear()
    tasks.clearActiveWorkspace()
    tasks.retireAssistantDispatches()
    const results = await Promise.allSettled([signingOut, tasks.cancelAll('account_logout')])
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failure) throw failure.reason
  })

  // A renderer list request is also the explicit recovery path after browser
  // OAuth. Force app-server to re-read connection state instead of returning a
  // card that may have been cached while the user was still in the browser.
  registerTrustedHandler(ipcMain, IPC.connectors.list, getWindow, () => core.refreshApps(true))
  registerTrustedHandler(ipcMain, IPC.connectors.connect, getWindow, (_event, appId: string) =>
    core.connectApp(requireString(appId, 'appId', 512))
  )
  registerTrustedHandler(ipcMain, IPC.core.send, getWindow, (_event, payload: unknown) => {
    assertPlainObject(payload, { name: 'Jarvis message', maxBytes: 64 * 1024 })
    const requestId = requireString(payload.requestId, 'requestId', 128)
    const text = requireString(payload.text, 'message', 32_000)
    const appIds = parseAppIds(payload.appIds)
    const request: ConversationSendRequest = { requestId, text, appIds }
    return core.send(request)
  })
  registerTrustedHandler(ipcMain, IPC.core.cancel, getWindow, (_event, requestId: string) =>
    core.cancel(requireString(requestId, 'requestId', 128))
  )

  registerTrustedHandler(ipcMain, IPC.codex.selectWorkspace, getWindow, async () => {
    const accountId = core.getAccountBinding()
    if (!accountId) throw new Error('Sign in with ChatGPT first')
    if (!core.getPrincipalId()) {
      throw new Error(
        'Verified Codex tasks require an eligible personal ChatGPT account; Chat and Apps remain available'
      )
    }
    const owner = getWindow()
    const options: OpenDialogOptions = {
      title: 'Choose the workspace Jarvis may use',
      buttonLabel: 'Use this workspace',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    const selected = result.filePaths[0]
    if (result.canceled || !selected) return null
    const grant = await workspaceGrants.create(selected, accountId)
    const workspaceScope = await workspaceGrants.resolve(grant.scopeId, accountId)
    await tasks.activateWorkspace(workspaceScope)
    return grant
  })
  registerTrustedHandler(
    ipcMain,
    IPC.codex.dispatch,
    getWindow,
    async (_event, payload: unknown) => {
      assertPlainObject(payload, { name: 'Codex task', maxBytes: 64 * 1024 })
      const prompt = requireString(payload.prompt, 'prompt', 32_000)
      const accountId = core.getAccountBinding()
      if (!accountId) throw new Error('Sign in with ChatGPT first')
      const scopeId = requireString(payload.scopeId, 'scopeId', 128)
      const workspaceScope = await workspaceGrants.resolve(scopeId, accountId)
      await tasks.activateWorkspace(workspaceScope)
      const boundary = parseBoundary(payload.boundary)
      const request = { prompt, workspaceScope, boundary }
      return tasks.dispatch(request)
    }
  )
  registerTrustedHandler(ipcMain, IPC.codex.cancel, getWindow, (_event, taskId: string) =>
    tasks.cancel(requireString(taskId, 'taskId', 128))
  )
  registerTrustedHandler(ipcMain, IPC.codex.list, getWindow, () => tasks.list())
  registerTrustedHandler(ipcMain, IPC.codex.receipts, getWindow, () => tasks.receipts())
  registerTrustedHandler(ipcMain, IPC.codex.loginStatus, getWindow, () => ({
    loggedIn: core.getStatus().state === 'signed_in',
    taskEligible: Boolean(core.getAccountBinding() && core.getPrincipalId())
  }))

  registerTrustedHandler(ipcMain, IPC.approvals.list, getWindow, () => actions.listApprovals())
  registerTrustedHandler(ipcMain, IPC.approvals.decide, getWindow, (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Approval decision is malformed')
    }
    const value = payload as Record<string, unknown>
    const approvalId = requireString(value.approvalId, 'approvalId', 128)
    if (value.decision !== 'approve' && value.decision !== 'deny') {
      throw new Error('Approval decision is invalid')
    }
    const accountId = core.getAccountBinding()
    const processEpoch = appServer.generation
    if (!accountId || !processEpoch) throw new Error('Approval context changed')
    actions.decide(approvalId, value.decision, {
      processEpoch,
      accountId,
      providerGeneration: processEpoch
    })
  })
}

function parseBoundary(value: unknown): CodexDispatchRequest['boundary'] {
  if (value === undefined) return undefined
  assertPlainObject(value, { name: 'Codex task boundary', maxBytes: 1_024 })
  const wallClockMs = value.wallClockMs
  const maxTurns = value.maxTurns
  if (
    wallClockMs !== undefined &&
    (typeof wallClockMs !== 'number' || !Number.isFinite(wallClockMs))
  ) {
    throw new Error('wallClockMs must be a finite number')
  }
  if (maxTurns !== undefined && (typeof maxTurns !== 'number' || !Number.isFinite(maxTurns))) {
    throw new Error('maxTurns must be a finite number')
  }
  return {
    ...(wallClockMs === undefined ? {} : { wallClockMs }),
    ...(maxTurns === undefined ? {} : { maxTurns })
  }
}

function parseAppIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 16) throw new Error('appIds must be a short list')
  return value.map((id, index) => requireString(id, `appIds[${index}]`, 512))
}

function send(getWindow: () => BrowserWindow | null, channel: string, payload: unknown): void {
  const window = getWindow()
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
}
