import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  ActionReceiptRow,
  CodexDispatchRequest,
  CodexEventRow,
  CodexTaskRow,
  CodexTerminalState
} from '../../../shared/types'
import {
  JARVIS_TASK_PERMISSION_PROFILE,
  TASK_TOOL_CONFIG,
  type CommandExecutionApprovalParams,
  type CommandAction,
  type DynamicToolCallResponse,
  type FileChangeApprovalParams,
  type FileUpdateChange,
  type JarvisAppServer,
  type JsonValue,
  type ServerRequestContext
} from '../appServer'
import {
  ActionCoordinator,
  assembleReceipt,
  assertPathInsideScope,
  revalidateWorkspaceScope,
  type PreparedAction,
  type WorkspaceScope
} from '../actions'
import {
  assistantCodexToolFailure,
  claimsAssistantCodexNamespace,
  validateAssistantCodexToolCall,
  type AssistantCodexBinding,
  type AssistantCodexToolCall,
  type AssistantCodexToolContext
} from './assistantTool'
import {
  captureWorkspaceWritePlan,
  claimsTaskWorkspaceNamespace,
  executeWorkspaceReadTool,
  hintedTaskThreadId,
  revalidateWorkspaceWritePlan,
  TASK_WORKSPACE_DYNAMIC_TOOLS,
  validateWorkspaceToolCall,
  verifyWorkspaceWrite,
  workspaceToolFailure,
  type ValidatedWorkspaceToolCall
} from './workspaceTools'
import type { WorkspaceWriter } from './nativeWorkspaceWriter'

const DEFAULT_WALL_CLOCK_MS = 10 * 60_000
const MAX_EVENT_ROWS = 1_000
const MAX_FINAL_TEXT_CHARS = 32_000
const MAX_PATCH_CHANGES = 256
const MAX_PATCH_ARGUMENT_BYTES = 240 * 1024
const MAX_VERIFICATION_FILE_BYTES = 240 * 1024
const MAX_TASK_TOOL_CALLS = 2_048
const ACTIVE_WORKSPACE_TTL_MS = 8 * 60 * 60_000

interface CapturedPatch {
  generation: string
  threadId: string
  turnId: string
  itemId: string
  changes: readonly FileUpdateChange[]
  fingerprint: string
}

type FileVerificationPlan = {
  itemId: string
  turnId: string
  patchFingerprint: string
  paths: readonly string[]
} & (
  | {
      kind: 'add'
      path: string
      expected: Buffer
    }
  | {
      kind: 'delete'
      path: string
      preIdentity: FileIdentity
    }
  | {
      kind: 'unknown'
      reason: string
    }
)

interface FileIdentity {
  dev: bigint
  ino: bigint
  nlink: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

type StableFileRead =
  { ok: true; bytes: Buffer; identity: FileIdentity } | { ok: false; reason: string }

interface VerificationResult {
  verified: boolean
  reason: string
}

interface TaskRecord {
  row: CodexTaskRow
  accountId: string
  principalId: string
  generation: string
  scope: WorkspaceScope
  wallClockMs: number
  timer: NodeJS.Timeout | null
  finalText: string
  activeTurnId: string | null
  actionItems: Map<string, PreparedAction[]>
  filePatches: Map<string, CapturedPatch>
  fileVerificationPlans: Map<string, FileVerificationPlan>
  toolCalls: Map<string, { fingerprint: string; promise: Promise<DynamicToolCallResponse> }>
  settlementChain: Promise<void>
}

interface ActiveWorkspaceSelection {
  readonly selectionId: string
  readonly accountId: string
  readonly principalId: string
  readonly generation: string
  readonly scope: Readonly<WorkspaceScope>
  readonly expiresAt: number
}

interface DeduplicatedAssistantDispatch {
  readonly key: string
  readonly fingerprint: string
  readonly binding: AssistantCodexBinding
  readonly promise: Promise<DynamicToolCallResponse>
  readonly retirement: { retired: boolean }
  state: 'pending' | 'settled'
}

type TaskListener = (task: CodexTaskRow) => void
type EventListener = (taskId: string, event: CodexEventRow) => void

export interface JarvisTaskServiceOptions {
  appServer: JarvisAppServer
  actions: ActionCoordinator
  workspaceWriter: WorkspaceWriter
  accountBinding: () => string | null
  principalBinding: () => string | null
}

export interface ScopedCodexDispatchRequest extends CodexDispatchRequest {
  workspaceScope: Readonly<WorkspaceScope>
}

export class JarvisTaskService {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly threads = new Map<string, TaskRecord>()
  private readonly turns = new Map<string, TaskRecord>()
  private readonly taskListeners = new Set<TaskListener>()
  private readonly eventListeners = new Set<EventListener>()
  private readonly receiptedAttempts = new Set<string>()
  private assistantDispatchCall: DeduplicatedAssistantDispatch | null = null
  private activeWorkspace: ActiveWorkspaceSelection | null = null
  private workspaceSelectionEpoch = 0
  private dispatchReservationHeld = false

  constructor(private readonly options: JarvisTaskServiceOptions) {
    const server = options.appServer
    server.subscribe('turn/started', ({ params, generation }) => {
      const record = this.threads.get(params.threadId)
      if (!record || !this.isLiveBinding(record, generation)) return
      record.row.threadId = params.threadId
      record.activeTurnId = params.turn.id
      this.turns.set(params.turn.id, record)
      this.pushEvent(record, 'turn_started', 'Codex turn started')
    })
    server.subscribe('item/agentMessage/delta', ({ params, generation }) => {
      const record = this.turns.get(params.turnId)
      if (record && this.isLiveBinding(record, generation)) {
        record.finalText = appendBounded(record.finalText, params.delta, MAX_FINAL_TEXT_CHARS)
      }
    })
    server.subscribe('item/fileChange/patchUpdated', ({ params, generation }) => {
      this.captureFilePatch(params, generation)
    })
    server.subscribe('item/completed', ({ params, generation }) => {
      const record = this.threads.get(params.threadId)
      if (!record || record.generation !== generation) return
      this.enqueueSettlement(record, () =>
        this.settleItem(record, params.item as Record<string, unknown>)
      )
    })
    server.subscribe('turn/completed', ({ params, generation }) => {
      this.retireAssistantDispatch((entry) =>
        sameAssistantTurn(entry.binding, generation, params.threadId, params.turn.id)
      )
      const record = this.turns.get(params.turn.id) ?? this.threads.get(params.threadId)
      if (record && record.generation === generation) {
        this.enqueueSettlement(record, () =>
          this.finishTurn(record, params.turn.status, params.turn.items)
        )
      }
    })
    server.onLifecycle((event) => {
      const retiredGeneration =
        event.kind === 'restarting'
          ? event.previousGeneration
          : event.kind === 'exited'
            ? event.generation
            : null
      if (retiredGeneration) {
        this.retireAssistantDispatch(
          (entry) => entry.binding.providerGeneration === retiredGeneration
        )
      }
      if (
        (event.kind === 'restarting' &&
          this.activeWorkspace?.generation === event.previousGeneration) ||
        (event.kind === 'exited' && this.activeWorkspace?.generation === event.generation)
      ) {
        this.clearActiveWorkspace()
      }
      if (event.kind !== 'exited' || event.expected) return
      for (const record of this.tasks.values()) {
        if (record.row.state !== 'running' || record.generation !== event.generation) continue
        for (const attempts of record.actionItems.values()) {
          for (const prepared of attempts) {
            if (prepared.attempt.state === 'dispatched' || prepared.attempt.state === 'observed') {
              this.safeUnknown(prepared, 'app_server_exited')
            }
          }
        }
        this.finishRecord(record, 'failed', 'unknown_outcome', 'The local Codex process exited.')
      }
    })
  }

  onTask(listener: TaskListener): () => void {
    this.taskListeners.add(listener)
    return () => this.taskListeners.delete(listener)
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  list(): CodexTaskRow[] {
    const accountId = this.options.accountBinding()
    if (!accountId) return []
    return [...this.tasks.values()]
      .filter((record) => record.accountId === accountId)
      .map((record) => record.row)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  receipts(): ActionReceiptRow[] {
    const principalId = this.options.principalBinding()
    if (!principalId) return []
    return this.options.actions.listReceipts(principalId, 200).map((receipt) => {
      if (receipt.verification === 'pending') {
        throw new Error(`Terminal receipt ${receipt.receiptId} still has pending verification`)
      }
      return { ...receipt, verification: receipt.verification }
    })
  }

  /**
   * Records the native-picker selection used by the assistant dispatch tool.
   * The model never receives or supplies this capability, path, or identity.
   */
  async activateWorkspace(scope: Readonly<WorkspaceScope>): Promise<void> {
    const selectionEpoch = ++this.workspaceSelectionEpoch
    this.activeWorkspace = null
    const accountId = this.options.accountBinding()
    const principalId = this.options.principalBinding()
    const generation = this.options.appServer.generation
    if (!accountId || !principalId || !generation) {
      throw new Error('Verified Codex tasks require an eligible personal ChatGPT account')
    }
    const currentScope = Object.freeze({ ...(await revalidateWorkspaceScope(scope)) })
    if (
      selectionEpoch !== this.workspaceSelectionEpoch ||
      this.options.accountBinding() !== accountId ||
      this.options.principalBinding() !== principalId ||
      this.options.appServer.generation !== generation
    ) {
      throw new Error('The account or Codex process changed while choosing the folder')
    }
    this.activeWorkspace = Object.freeze({
      selectionId: randomUUID(),
      accountId,
      principalId,
      generation,
      scope: currentScope,
      expiresAt: Date.now() + ACTIVE_WORKSPACE_TTL_MS
    })
  }

  clearActiveWorkspace(): void {
    this.workspaceSelectionEpoch += 1
    this.activeWorkspace = null
  }

  /**
   * Retires the replay tombstone after its account authority has been revoked.
   * A pending call keeps the global slot until it settles, so retirement can
   * never create two simultaneous assistant dispatch approvals.
   */
  retireAssistantDispatches(): void {
    this.retireAssistantDispatch(() => true)
  }

  async dispatch(request: ScopedCodexDispatchRequest): Promise<{ taskId: string }> {
    return this.dispatchWithReservation(request)
  }

  private async dispatchWithReservation(
    request: ScopedCodexDispatchRequest,
    startupGuard?: () => boolean,
    beforeProviderDispatch?: () => void
  ): Promise<{ taskId: string }> {
    if (
      this.dispatchReservationHeld ||
      [...this.tasks.values()].some((record) => record.row.state === 'running')
    ) {
      throw new Error('One Codex task is already running')
    }
    this.dispatchReservationHeld = true
    try {
      return await this.dispatchReserved(request, startupGuard, beforeProviderDispatch)
    } finally {
      this.dispatchReservationHeld = false
    }
  }

  private async dispatchReserved(
    request: ScopedCodexDispatchRequest,
    startupGuard?: () => boolean,
    beforeProviderDispatch?: () => void
  ): Promise<{ taskId: string }> {
    const accountId = this.options.accountBinding()
    const principalId = this.options.principalBinding()
    const generation = this.options.appServer.generation
    if (!accountId || !principalId || !generation) {
      throw new Error('This ChatGPT account cannot authorize durable Jarvis actions')
    }
    if (startupGuard && !startupGuard()) {
      throw new Error('The assistant task context changed before dispatch')
    }
    const prompt = requireText(request.prompt, 'prompt', 32_000)
    const currentScope = await revalidateWorkspaceScope(request.workspaceScope)
    if (startupGuard && !startupGuard()) {
      throw new Error('The assistant task context changed while validating the folder')
    }
    const scope: WorkspaceScope = Object.freeze({ ...currentScope })
    const taskId = randomUUID()
    const wallClockMs = clamp(
      request.boundary?.wallClockMs,
      10_000,
      60 * 60_000,
      DEFAULT_WALL_CLOCK_MS
    )
    const record: TaskRecord = {
      row: {
        taskId,
        threadId: null,
        prompt,
        startedAt: Date.now(),
        state: 'running',
        events: []
      },
      accountId,
      principalId,
      generation,
      scope,
      wallClockMs,
      timer: null,
      finalText: '',
      activeTurnId: null,
      actionItems: new Map(),
      filePatches: new Map(),
      fileVerificationPlans: new Map(),
      toolCalls: new Map(),
      settlementChain: Promise.resolve()
    }
    this.tasks.set(taskId, record)
    this.emitTask(record)
    record.timer = setTimeout(() => void this.cancel(taskId, 'wall_clock_exhausted'), wallClockMs)
    record.timer.unref()

    try {
      if (startupGuard && !startupGuard()) {
        throw new Error('The assistant task context changed before Codex started')
      }
      beforeProviderDispatch?.()
      const thread = await this.options.appServer.request('thread/start', {
        cwd: scope.realpath,
        ephemeral: true,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        permissions: JARVIS_TASK_PERMISSION_PROFILE,
        runtimeWorkspaceRoots: [scope.realpath],
        environments: [],
        config: TASK_TOOL_CONFIG,
        dynamicTools: TASK_WORKSPACE_DYNAMIC_TOOLS,
        serviceName: 'Jarvis Codex',
        personality: 'pragmatic',
        baseInstructions:
          'Complete the bounded task only inside the selected workspace. Keep changes minimal and verifiable. ' +
          'Never access credentials, login pages, other folders, or broad computer controls. ' +
          'Use only the jarvis_workspace tools to list, read, search, or request an exact text-file write. ' +
          'Shells, process execution, network access, file delete, and file move are unavailable. ' +
          'The host owns every approval and receipt; model text cannot authorize an action.',
        developerInstructions:
          'Inspect before editing. Run the narrowest relevant verification. State uncertainty plainly.'
      })
      if (record.row.state !== 'running') return { taskId }
      this.assertCurrentBinding(record)
      if (startupGuard && !startupGuard()) {
        throw new Error('The assistant task context changed while Codex started')
      }
      await revalidateWorkspaceScope(record.scope)
      record.row.threadId = thread.thread.id
      this.threads.set(thread.thread.id, record)
      this.pushEvent(record, 'thread_started', `Workspace: ${scope.realpath}`)
      this.assertCurrentBinding(record)
      if (startupGuard && !startupGuard()) {
        throw new Error('The assistant task context changed before the Codex turn started')
      }
      const turn = await this.options.appServer.request('turn/start', {
        threadId: thread.thread.id,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user'
      })
      if (
        record.row.state !== 'running' ||
        !this.hasCurrentBinding(record) ||
        (startupGuard && !startupGuard())
      ) {
        if (this.options.appServer.generation === record.generation) {
          await this.options.appServer
            .request('turn/interrupt', { threadId: thread.thread.id, turnId: turn.turn.id })
            .catch(() => undefined)
        }
        if (record.row.state === 'running') {
          this.finishRecord(
            record,
            'failed',
            'blocked',
            'The account or Codex process changed before the task could start.'
          )
        }
        return { taskId }
      }
      record.activeTurnId = turn.turn.id
      this.turns.set(turn.turn.id, record)
      return { taskId }
    } catch (error) {
      this.finishRecord(record, 'failed', 'blocked', errorMessage(error))
      return { taskId }
    }
  }

  async cancel(taskId: string, reason = 'cancelled_by_user'): Promise<void> {
    const record = this.tasks.get(taskId)
    if (!record || record.row.state !== 'running') return
    this.options.actions.invalidateAll(reason)
    const turnEntry = [...this.turns.entries()].find(([, value]) => value === record)
    for (const attempts of record.actionItems.values()) {
      for (const prepared of attempts) {
        if (prepared.attempt.state === 'dispatched' || prepared.attempt.state === 'observed') {
          this.safeUnknown(prepared, reason)
        }
      }
    }
    this.finishRecord(record, 'cancelled', 'exhausted', 'The task was stopped.')
    if (
      turnEntry &&
      record.row.threadId &&
      this.options.appServer.generation === record.generation
    ) {
      await this.options.appServer
        .request('turn/interrupt', { threadId: record.row.threadId, turnId: turnEntry[0] })
        .catch(() => undefined)
    }
  }

  async cancelAll(reason = 'cancelled_by_host'): Promise<void> {
    const liveTaskIds = [...this.tasks.values()]
      .filter((record) => record.row.state === 'running')
      .map((record) => record.row.taskId)
    await Promise.all(liveTaskIds.map((taskId) => this.cancel(taskId, reason)))
  }

  handleAssistantToolCall(
    input: unknown,
    context: AssistantCodexToolContext
  ): Promise<DynamicToolCallResponse> | null {
    this.clearActiveWorkspaceIfStale()
    if (!claimsAssistantCodexNamespace(input)) return null
    this.retireAssistantDispatchIfAuthorityChanged()

    let call: AssistantCodexToolCall
    let binding: AssistantCodexBinding
    try {
      call = validateAssistantCodexToolCall(input)
      requireRequestId(context.rpcId)
      if (!context.binding) throw new Error('Assistant task binding is unavailable')
      binding = Object.freeze({ ...context.binding })
      if (!this.isAssistantToolBindingCurrent(call, context, binding)) {
        throw new Error('Assistant task binding is no longer current')
      }
    } catch {
      return Promise.resolve(
        assistantCodexToolFailure('The host rejected this Codex dispatch request.')
      )
    }

    const selection = this.currentActiveWorkspace(binding)
    if (!selection) {
      return Promise.resolve(
        assistantCodexToolFailure(
          'No active Codex folder is available. Ask the user to choose a folder in the Codex panel, then try again.'
        )
      )
    }

    const key = assistantDispatchKey(call, binding)
    const fingerprint = `${call.fingerprint}:${selection.selectionId}:${context.rpcId}`
    const existing = this.assistantDispatchCall
    if (existing) {
      if (existing.key === key) {
        return existing.fingerprint === fingerprint && !existing.retirement.retired
          ? existing.promise
          : Promise.resolve(
              assistantCodexToolFailure('A conflicting duplicate Codex dispatch was rejected.')
            )
      }
      return Promise.resolve(
        assistantCodexToolFailure(
          'One assistant-originated Codex dispatch is already reserved. Wait for the current assistant turn to finish before asking again.'
        )
      )
    }

    const retirement = { retired: false }
    const promise = this.executeAssistantDispatch(
      call,
      context,
      binding,
      selection,
      () => !retirement.retired
    ).catch(() =>
      assistantCodexToolFailure('The Codex task failed closed before it could be dispatched.')
    )
    const entry: DeduplicatedAssistantDispatch = {
      key,
      fingerprint,
      binding,
      promise,
      retirement,
      state: 'pending'
    }
    this.assistantDispatchCall = entry
    void promise.then(
      () => this.settleAssistantDispatch(entry),
      () => this.settleAssistantDispatch(entry)
    )
    return promise
  }

  private settleAssistantDispatch(entry: DeduplicatedAssistantDispatch): void {
    entry.state = 'settled'
    if (entry.retirement.retired && this.assistantDispatchCall === entry) {
      this.assistantDispatchCall = null
    }
  }

  private retireAssistantDispatch(
    matches: (entry: DeduplicatedAssistantDispatch) => boolean
  ): void {
    const entry = this.assistantDispatchCall
    if (!entry || !matches(entry)) return
    entry.retirement.retired = true
    if (entry.state === 'settled') this.assistantDispatchCall = null
  }

  private retireAssistantDispatchIfAuthorityChanged(): void {
    const accountId = this.options.accountBinding()
    const principalId = this.options.principalBinding()
    const generation = this.options.appServer.generation
    this.retireAssistantDispatch(
      (entry) =>
        entry.binding.accountId !== accountId ||
        entry.binding.principalId !== principalId ||
        entry.binding.providerGeneration !== generation
    )
  }

  private async executeAssistantDispatch(
    call: AssistantCodexToolCall,
    context: AssistantCodexToolContext,
    binding: AssistantCodexBinding,
    selection: ActiveWorkspaceSelection,
    reservationCurrent: () => boolean
  ): Promise<DynamicToolCallResponse> {
    const guard = (): boolean =>
      reservationCurrent() &&
      this.activeWorkspace === selection &&
      this.isAssistantToolBindingCurrent(call, context, binding) &&
      this.currentActiveWorkspace(binding) === selection
    let prepared: PreparedAction | null = null
    try {
      await revalidateWorkspaceScope(selection.scope)
      if (!guard()) {
        return assistantCodexToolFailure(
          'The selected Codex folder or assistant context changed. Ask the user to choose the folder again.'
        )
      }
      prepared = this.options.actions.prepare({
        accountId: binding.accountId,
        principalId: binding.principalId,
        capability: 'workspace.task.dispatch',
        operation: 'Dispatch this Codex task into the selected folder',
        target: selection.scope.realpath,
        arguments: {
          prompt: call.prompt,
          workspace: selection.scope.realpath,
          selectionId: selection.selectionId,
          threadId: call.threadId,
          turnId: call.turnId,
          callId: call.callId,
          rpcId: context.rpcId
        },
        dataClassification: 'account',
        workspaceRealpath: selection.scope.realpath,
        workspaceIdentity: selection.scope.identity,
        networkRequired: false,
        providerGeneration: binding.providerGeneration,
        mutating: true
      })
      if (prepared.policy.disposition === 'deny') {
        this.saveTerminalReceipt(prepared)
        return assistantCodexToolFailure('Host policy denied the Codex task dispatch.')
      }
      if (prepared.policy.disposition !== 'require_approval') {
        this.blockAndSave(prepared, 'task_dispatch_approval_policy_missing')
        return assistantCodexToolFailure('The Codex task dispatch requires one-time approval.')
      }

      const approved = await this.options.actions.requestApproval(
        prepared,
        {
          processEpoch: binding.processEpoch,
          rpcId: context.rpcId,
          threadId: call.threadId,
          turnId: call.turnId,
          itemId: call.callId
        },
        context.signal
      )
      if (!approved) {
        this.saveTerminalReceipt(prepared)
        return assistantCodexToolFailure(
          'The Codex task was not dispatched because approval was denied or expired.'
        )
      }

      await revalidateWorkspaceScope(selection.scope)
      if (!guard()) {
        this.blockAndSave(prepared, 'task_dispatch_context_changed_after_approval')
        return assistantCodexToolFailure(
          'The approved Codex task was not dispatched because its account, turn, or selected folder changed.'
        )
      }
      const { taskId } = await this.dispatchWithReservation(
        { prompt: call.prompt, workspaceScope: selection.scope },
        guard,
        () => {
          if (!prepared || !guard()) {
            throw new Error('The approved assistant task context changed before provider dispatch')
          }
          this.options.actions.markDispatched(prepared, context.rpcId)
        }
      )
      const record = this.tasks.get(taskId)
      if (!record || (record.row.state !== 'running' && record.row.state !== 'done')) {
        this.settleBeforeDispatchFailure(prepared, 'task_dispatch_failed_after_provider_dispatch')
        return assistantCodexToolFailure(
          'Codex could not start the bounded task. No workspace result is being claimed.'
        )
      }
      this.options.actions.markObserved(prepared, {
        providerRequestId: context.rpcId,
        providerResourceId: taskId
      })
      this.verifyAndSave(
        prepared,
        `Codex task ${taskId} was dispatched into the locally selected folder.`
      )
      return {
        contentItems: [
          {
            type: 'inputText',
            text:
              `Codex task ${taskId} was dispatched into the folder selected locally in the Codex panel. ` +
              'This confirms dispatch only; it does not claim that any workspace change succeeded. Track the task and any required write approval in the Codex panel.'
          }
        ],
        success: true
      }
    } catch (error) {
      if (prepared) this.settleBeforeDispatchFailure(prepared, 'task_dispatch_rejected')
      return assistantCodexToolFailure(assistantDispatchFailureMessage(error))
    }
  }

  private currentActiveWorkspace(binding: AssistantCodexBinding): ActiveWorkspaceSelection | null {
    this.clearActiveWorkspaceIfStale()
    const selection = this.activeWorkspace
    if (
      !selection ||
      selection.expiresAt <= Date.now() ||
      selection.accountId !== binding.accountId ||
      selection.principalId !== binding.principalId ||
      selection.generation !== binding.providerGeneration ||
      this.options.accountBinding() !== selection.accountId ||
      this.options.principalBinding() !== selection.principalId ||
      this.options.appServer.generation !== selection.generation
    ) {
      if (selection) this.clearActiveWorkspace()
      return null
    }
    return selection
  }

  private clearActiveWorkspaceIfStale(): void {
    const selection = this.activeWorkspace
    if (
      selection &&
      (selection.expiresAt <= Date.now() ||
        this.options.accountBinding() !== selection.accountId ||
        this.options.principalBinding() !== selection.principalId ||
        this.options.appServer.generation !== selection.generation)
    ) {
      this.clearActiveWorkspace()
    }
  }

  private isAssistantToolBindingCurrent(
    call: AssistantCodexToolCall,
    context: AssistantCodexToolContext,
    binding: AssistantCodexBinding
  ): boolean {
    if (
      context.signal.aborted ||
      context.generation !== binding.providerGeneration ||
      binding.processEpoch !== binding.providerGeneration ||
      call.threadId !== binding.threadId ||
      call.turnId !== binding.turnId ||
      this.options.accountBinding() !== binding.accountId ||
      this.options.principalBinding() !== binding.principalId ||
      this.options.appServer.generation !== binding.providerGeneration
    ) {
      return false
    }
    try {
      return sameAssistantBinding(context.currentBinding(), binding)
    } catch {
      return false
    }
  }

  handleToolCall(
    input: unknown,
    context: ServerRequestContext
  ): Promise<DynamicToolCallResponse> | null {
    const hintedThread = hintedTaskThreadId(input)
    const record = hintedThread ? this.threads.get(hintedThread) : undefined
    if (!record && !claimsTaskWorkspaceNamespace(input)) return null

    let call: ValidatedWorkspaceToolCall
    try {
      call = validateWorkspaceToolCall(input)
      if (!record || !this.isWorkspaceToolContextCurrent(record, call, context)) {
        throw new Error('Workspace tool context is no longer current')
      }
      requireRequestId(context.requestId)
    } catch {
      return Promise.resolve(workspaceToolFailure('The host rejected this workspace tool request.'))
    }

    const existing = record.toolCalls.get(call.callId)
    if (existing) {
      return existing.fingerprint === call.fingerprint
        ? existing.promise
        : Promise.resolve(
            workspaceToolFailure('A conflicting duplicate workspace tool call was rejected.')
          )
    }
    if (record.toolCalls.size >= MAX_TASK_TOOL_CALLS) {
      return Promise.resolve(
        workspaceToolFailure('The workspace tool safety cache is full; restart the task.')
      )
    }

    const promise = this.executeWorkspaceToolCall(record, call, context).catch(() =>
      workspaceToolFailure('The workspace tool failed closed.')
    )
    record.toolCalls.set(call.callId, { fingerprint: call.fingerprint, promise })
    return promise
  }

  private async executeWorkspaceToolCall(
    record: TaskRecord,
    call: ValidatedWorkspaceToolCall,
    context: ServerRequestContext
  ): Promise<DynamicToolCallResponse> {
    try {
      await this.assertWorkspaceToolContextCurrent(record, call, context)
      if (call.tool !== 'write_text') {
        const result = await executeWorkspaceReadTool(record.scope, call)
        await this.assertWorkspaceToolContextCurrent(record, call, context)
        this.pushEvent(record, 'command', `Workspace ${workspaceToolLabel(call.tool)} completed`)
        return result
      }
      return await this.executeWorkspaceWrite(record, call, context)
    } catch (error) {
      this.pushEvent(record, 'error', errorMessage(error))
      return workspaceToolFailure('The workspace tool request was rejected by host safety checks.')
    }
  }

  private async executeWorkspaceWrite(
    record: TaskRecord,
    call: ValidatedWorkspaceToolCall,
    context: ServerRequestContext
  ): Promise<DynamicToolCallResponse> {
    let prepared: PreparedAction | null = null
    try {
      const plan = await captureWorkspaceWritePlan(record.scope, call)
      await this.assertWorkspaceToolContextCurrent(record, call, context)
      prepared = this.options.actions.prepare({
        accountId: record.accountId,
        principalId: record.principalId,
        capability: 'workspace.write',
        operation:
          plan.kind === 'add'
            ? `Create ${plan.relativePath} with the exact full contents shown below`
            : `Replace the entire contents of ${plan.relativePath} with the exact text shown below`,
        target: plan.targetPath,
        arguments: {
          changes: [
            {
              path: plan.relativePath,
              kind:
                plan.kind === 'add'
                  ? { type: 'add' as const }
                  : { type: 'update' as const, move_path: null },
              diff: plan.expected.toString('utf8')
            }
          ],
          threadId: call.threadId,
          turnId: call.turnId,
          callId: call.callId
        },
        dataClassification: 'account',
        workspaceRealpath: record.scope.realpath,
        workspaceIdentity: record.scope.identity,
        networkRequired: false,
        providerGeneration: context.generation,
        mutating: true
      })
      const itemActions = record.actionItems.get(call.callId) ?? []
      itemActions.push(prepared)
      record.actionItems.set(call.callId, itemActions)
      if (prepared.policy.disposition === 'deny') {
        this.saveTerminalReceipt(prepared)
        return workspaceToolFailure('Host policy denied the workspace write.')
      }
      if (prepared.policy.disposition !== 'require_approval') {
        this.blockAndSave(prepared, 'workspace_write_approval_policy_missing')
        return workspaceToolFailure('The workspace write requires explicit approval.')
      }

      const approved = await this.options.actions.requestApproval(
        prepared,
        {
          processEpoch: context.generation,
          rpcId: String(context.requestId),
          threadId: call.threadId,
          turnId: call.turnId,
          itemId: call.callId
        },
        context.signal
      )
      if (!approved) {
        this.saveTerminalReceipt(prepared)
        this.pushEvent(record, 'error', `${prepared.intent.operation} was not approved`)
        return workspaceToolFailure('The workspace write was not approved.')
      }

      await this.assertWorkspaceToolContextCurrent(record, call, context)
      await revalidateWorkspaceWritePlan(record.scope, plan)
      await this.assertWorkspaceToolContextCurrent(record, call, context)
      const preparedWrite = await this.options.workspaceWriter.prepare(record.scope, plan)
      await revalidateWorkspaceWritePlan(record.scope, plan)
      await this.assertWorkspaceToolContextCurrent(record, call, context)
      this.options.actions.markDispatched(prepared, String(context.requestId))
      if (!this.isWorkspaceToolContextCurrent(record, call, context)) {
        this.unknownAndSave(prepared, 'workspace_write_context_changed_after_dispatch')
        return workspaceToolFailure(
          'The workspace write was not run because its context changed after dispatch.'
        )
      }

      try {
        await this.options.workspaceWriter.execute(preparedWrite, context.signal)
      } catch {
        this.unknownAndSave(prepared, 'workspace_write_failed_after_dispatch')
        return workspaceToolFailure(
          'The workspace write may have started, but Jarvis could not verify it.'
        )
      }

      try {
        this.options.actions.markObserved(prepared, {
          providerRequestId: String(context.requestId),
          providerResourceId: call.callId
        })
      } catch {
        this.unknownAndSave(prepared, 'workspace_write_observation_failed')
        return workspaceToolFailure(
          'The workspace write may have completed, but Jarvis could not record it.'
        )
      }

      const verification = await verifyWorkspaceWrite(record.scope, plan)
      if (!verification.verified || !this.isWorkspaceToolContextCurrent(record, call, context)) {
        this.unknownAndSave(
          prepared,
          verification.verified
            ? 'workspace_write_context_changed_before_confirmation'
            : verification.reason
        )
        return workspaceToolFailure(
          'The workspace write may have completed, but its exact postcondition is unverified.'
        )
      }

      this.verifyAndSave(prepared)
      this.pushEvent(record, 'file_change', `${prepared.intent.operation} was verified`)
      return {
        contentItems: [
          {
            type: 'inputText',
            text: `${plan.relativePath} now contains the exact approved UTF-8 text; Jarvis verified the postcondition.`
          }
        ],
        success: true
      }
    } catch (error) {
      if (prepared) this.settleBeforeDispatchFailure(prepared, 'workspace_write_rejected')
      this.pushEvent(record, 'error', errorMessage(error))
      return workspaceToolFailure('The workspace write was rejected before a verified result.')
    }
  }

  private isWorkspaceToolContextCurrent(
    record: TaskRecord,
    call: ValidatedWorkspaceToolCall,
    context: ServerRequestContext
  ): boolean {
    return (
      this.hasCurrentBinding(record) &&
      this.options.principalBinding() === record.principalId &&
      context.generation === record.generation &&
      !context.signal.aborted &&
      record.row.threadId === call.threadId &&
      record.activeTurnId === call.turnId &&
      this.threads.get(call.threadId) === record &&
      this.turns.get(call.turnId) === record
    )
  }

  private async assertWorkspaceToolContextCurrent(
    record: TaskRecord,
    call: ValidatedWorkspaceToolCall,
    context: ServerRequestContext
  ): Promise<void> {
    if (!this.isWorkspaceToolContextCurrent(record, call, context)) {
      throw new Error('Workspace tool context changed')
    }
    await revalidateWorkspaceScope(record.scope)
    if (!this.isWorkspaceToolContextCurrent(record, call, context)) {
      throw new Error('Workspace tool context changed during scope verification')
    }
  }

  async reviewCommand(
    params: CommandExecutionApprovalParams,
    context: ServerRequestContext
  ): Promise<'accept' | 'decline'> {
    const record = this.threads.get(params.threadId)
    if (!record || !this.isApprovalContextCurrent(record, params.turnId, context)) {
      return 'decline'
    }
    let safeCwd: string
    try {
      safeCwd = await assertPathInsideScope(record.scope, params.cwd ?? record.scope.realpath)
    } catch {
      return 'decline'
    }
    const denyReason = await commandDenialReason(record.scope, safeCwd, params)
    return this.reviewMutation(record, params.itemId, params.turnId, context, {
      operation: commandApprovalLabel(params.command),
      target: safeCwd,
      eventKind: 'command',
      denyReason,
      networkRequired:
        params.networkApprovalContext != null ||
        params.proposedNetworkPolicyAmendments != null ||
        Boolean(
          params.additionalPermissions &&
          typeof params.additionalPermissions === 'object' &&
          'network' in params.additionalPermissions
        ),
      args: {
        approvalId: params.approvalId ?? null,
        environmentId: params.environmentId,
        startedAtMs: params.startedAtMs,
        command: params.command ?? null,
        cwd: safeCwd,
        commandActions: params.commandActions ?? null,
        reason: params.reason ?? null,
        networkApprovalContext: params.networkApprovalContext ?? null,
        proposedExecpolicyAmendment: params.proposedExecpolicyAmendment ?? null,
        proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments ?? null,
        additionalPermissions: params.additionalPermissions ?? null,
        availableDecisions: params.availableDecisions ?? null
      }
    })
  }

  async reviewFileChange(
    params: FileChangeApprovalParams,
    context: ServerRequestContext
  ): Promise<'accept' | 'decline'> {
    const record = this.threads.get(params.threadId)
    if (!record || !this.isApprovalContextCurrent(record, params.turnId, context)) {
      return 'decline'
    }
    const patchKey = actionKey(params.turnId, params.itemId)
    const patch = record.filePatches.get(patchKey)
    if (
      !patch ||
      patch.generation !== context.generation ||
      patch.threadId !== params.threadId ||
      patch.turnId !== params.turnId
    ) {
      this.pushEvent(record, 'error', 'File change declined because no exact patch was provided')
      return 'decline'
    }
    let affectedPaths: readonly string[]
    try {
      affectedPaths = await validatePatchPaths(record.scope, patch.changes)
    } catch (error) {
      this.pushEvent(record, 'error', errorMessage(error))
      return 'decline'
    }
    return this.reviewMutation(record, params.itemId, params.turnId, context, {
      operation: fileApprovalLabel(params.reason, affectedPaths, record.scope.realpath),
      target: record.scope.realpath,
      eventKind: 'file_change',
      denyReason: params.grantRoot != null ? 'session_write_grant_not_supported' : null,
      networkRequired: false,
      args: {
        startedAtMs: params.startedAtMs,
        reason: params.reason ?? null,
        grantRoot: params.grantRoot ?? null,
        patchFingerprint: patch.fingerprint,
        changes: patch.changes
      },
      stillCurrent: () =>
        record.filePatches.get(patchKey)?.fingerprint === patch.fingerprint &&
        record.filePatches.get(patchKey)?.generation === context.generation,
      captureVerification: () => captureFileVerificationPlan(record.scope, patch)
    })
  }

  private async reviewMutation(
    record: TaskRecord,
    itemId: string,
    turnId: string,
    context: ServerRequestContext,
    review: {
      operation: string
      target: string
      args: unknown
      eventKind: 'command' | 'file_change'
      networkRequired: boolean
      denyReason: string | null
      stillCurrent?: () => boolean
      captureVerification?: () => Promise<FileVerificationPlan>
    }
  ): Promise<'accept' | 'decline'> {
    if (!this.isApprovalContextCurrent(record, turnId, context)) return 'decline'
    let prepared: PreparedAction | null = null
    try {
      await revalidateWorkspaceScope(record.scope)
      const safeTarget = await assertPathInsideScope(record.scope, review.target)
      prepared = this.options.actions.prepare({
        accountId: record.accountId,
        principalId: record.principalId,
        capability: 'workspace.write',
        operation: review.operation,
        target: safeTarget,
        arguments: review.args,
        dataClassification: 'account',
        workspaceRealpath: record.scope.realpath,
        workspaceIdentity: record.scope.identity,
        networkRequired: review.networkRequired,
        providerGeneration: context.generation,
        mutating: true
      })
      const itemActions = record.actionItems.get(itemId) ?? []
      itemActions.push(prepared)
      record.actionItems.set(itemId, itemActions)
      if (prepared.policy.disposition === 'deny') {
        this.saveTerminalReceipt(prepared)
        this.pushEvent(record, 'error', prepared.policy.reason)
        return 'decline'
      }
      if (review.denyReason) {
        this.blockAndSave(prepared, review.denyReason)
        this.pushEvent(record, 'error', approvalDenialMessage(review.denyReason))
        return 'decline'
      }
      const approved = await this.options.actions.requestApproval(
        prepared,
        {
          processEpoch: context.generation,
          rpcId: String(context.requestId),
          threadId: record.row.threadId ?? undefined,
          turnId,
          itemId
        },
        context.signal
      )
      if (!approved) {
        this.saveTerminalReceipt(prepared)
        this.pushEvent(record, 'error', `${review.operation} was not approved`)
        return 'decline'
      }
      await revalidateWorkspaceScope(record.scope)
      const reboundTarget = await assertPathInsideScope(record.scope, review.target)
      if (
        reboundTarget !== safeTarget ||
        !this.isApprovalContextCurrent(record, turnId, context) ||
        context.signal.aborted ||
        (review.stillCurrent && !review.stillCurrent())
      ) {
        this.blockAndSave(prepared, 'approval_context_changed')
        return 'decline'
      }
      const capturedVerificationPlan = review.captureVerification
        ? await review.captureVerification()
        : null
      await revalidateWorkspaceScope(record.scope)
      const finalTarget = await assertPathInsideScope(record.scope, review.target)
      if (
        finalTarget !== safeTarget ||
        !this.isApprovalContextCurrent(record, turnId, context) ||
        context.signal.aborted ||
        (review.stillCurrent && !review.stillCurrent())
      ) {
        this.blockAndSave(prepared, 'approval_context_changed_during_snapshot')
        return 'decline'
      }
      const verificationPlan = capturedVerificationPlan
        ? await revalidateVerificationPlanBeforeDispatch(record.scope, capturedVerificationPlan)
        : null
      if (
        !this.isApprovalContextCurrent(record, turnId, context) ||
        context.signal.aborted ||
        (review.stillCurrent && !review.stillCurrent())
      ) {
        this.blockAndSave(prepared, 'approval_context_changed_after_snapshot')
        return 'decline'
      }
      this.options.actions.markDispatched(prepared, String(context.requestId))
      if (verificationPlan) {
        record.fileVerificationPlans.set(prepared.attempt.attemptId, verificationPlan)
      }
      this.pushEvent(record, review.eventKind, `${review.operation} approved`)
      return 'accept'
    } catch (error) {
      if (prepared) this.settleBeforeDispatchFailure(prepared, 'approval_review_failed')
      this.pushEvent(record, 'error', errorMessage(error))
      return 'decline'
    }
  }

  private captureFilePatch(
    params: {
      threadId: string
      turnId: string
      itemId: string
      changes: readonly FileUpdateChange[]
    },
    generation: string
  ): void {
    const record = this.threads.get(params.threadId)
    if (!record || !this.isLiveBinding(record, generation)) return
    const changes: FileUpdateChange[] = params.changes.map((change) => ({
      path: change.path,
      diff: change.diff,
      kind:
        change.kind.type === 'update'
          ? { type: 'update' as const, move_path: change.kind.move_path }
          : { type: change.kind.type }
    }))
    const serialized = serializeFileChanges(changes)
    if (
      changes.length === 0 ||
      changes.length > MAX_PATCH_CHANGES ||
      Buffer.byteLength(serialized, 'utf8') > MAX_PATCH_ARGUMENT_BYTES
    ) {
      record.filePatches.delete(actionKey(params.turnId, params.itemId))
      this.pushEvent(record, 'error', 'File change patch exceeded Jarvis safety limits')
      return
    }
    const patch: CapturedPatch = {
      generation,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      changes,
      fingerprint: createHash('sha256').update(serialized).digest('hex')
    }
    const key = actionKey(params.turnId, params.itemId)
    const previous = record.filePatches.get(key)
    record.filePatches.set(key, patch)

    if (previous && previous.fingerprint !== patch.fingerprint) {
      const attempts = record.actionItems.get(params.itemId) ?? []
      for (const prepared of attempts) {
        if (prepared.attempt.state === 'dispatched' || prepared.attempt.state === 'observed') {
          this.safeUnknown(prepared, 'patch_changed_after_dispatch')
        }
      }
    }
  }

  private isLiveBinding(record: TaskRecord, generation: string): boolean {
    return record.row.state === 'running' && record.generation === generation
  }

  private hasCurrentBinding(record: TaskRecord): boolean {
    return (
      record.row.state === 'running' &&
      this.options.appServer.generation === record.generation &&
      this.options.accountBinding() === record.accountId &&
      this.options.principalBinding() === record.principalId
    )
  }

  private assertCurrentBinding(record: TaskRecord): void {
    if (!this.hasCurrentBinding(record)) {
      throw new Error('The account or Codex process changed during task startup')
    }
  }

  private isApprovalContextCurrent(
    record: TaskRecord,
    turnId: string,
    context: ServerRequestContext
  ): boolean {
    return (
      this.hasCurrentBinding(record) &&
      context.generation === record.generation &&
      !context.signal.aborted &&
      record.activeTurnId === turnId &&
      this.turns.get(turnId) === record
    )
  }

  private settleBeforeDispatchFailure(prepared: PreparedAction, code: string): void {
    try {
      if (prepared.attempt.state === 'intent' || prepared.attempt.state === 'approved') {
        this.blockAndSave(prepared, code)
      } else if (prepared.attempt.state === 'dispatched' || prepared.attempt.state === 'observed') {
        this.unknownAndSave(prepared, code)
      } else {
        this.saveTerminalReceipt(prepared)
      }
    } catch {
      // A concurrent cancellation or completion owns the terminal transition.
    }
  }

  private saveTerminalReceipt(prepared: PreparedAction): void {
    if (this.receiptedAttempts.has(prepared.attempt.attemptId)) return
    if (!isTerminalActionState(prepared.attempt.state)) return
    this.options.actions.saveReceipt(assembleReceipt(prepared.attempt))
    this.receiptedAttempts.add(prepared.attempt.attemptId)
  }

  private async settleItem(record: TaskRecord, item: Record<string, unknown>): Promise<void> {
    const itemId = typeof item.id === 'string' ? item.id : ''
    const preparedActions = record.actionItems.get(itemId)
    if (!preparedActions) return
    const status = typeof item.status === 'string' ? item.status : 'unknown'
    for (const prepared of preparedActions) {
      if (isTerminalActionState(prepared.attempt.state)) continue
      try {
        if (prepared.attempt.state === 'intent' || prepared.attempt.state === 'approved') {
          this.blockAndSave(prepared, `provider_${status}`)
          continue
        }
        if (prepared.attempt.state === 'dispatched') {
          this.options.actions.markObserved(prepared, { providerResourceId: itemId })
        }
        const verificationPlan = record.fileVerificationPlans.get(prepared.attempt.attemptId)
        if (item.type === 'fileChange' && status === 'completed' && verificationPlan) {
          const completedFingerprint = fingerprintCompletedChanges(item.changes)
          const verification =
            completedFingerprint === verificationPlan.patchFingerprint
              ? await verifyFilePostcondition(record.scope, verificationPlan)
              : { verified: false, reason: 'completed_patch_mismatch' }
          if (isTerminalActionState(prepared.attempt.state)) continue
          if (
            verification.verified &&
            this.hasCurrentBinding(record) &&
            record.filePatches.get(actionKey(verificationPlan.turnId, verificationPlan.itemId))
              ?.fingerprint === verificationPlan.patchFingerprint
          ) {
            this.verifyAndSave(prepared)
            this.pushEvent(record, 'file_change', `${prepared.intent.operation} was verified`)
            continue
          }
          this.safeUnknown(
            prepared,
            verification.verified ? 'verification_context_changed' : verification.reason
          )
        } else {
          // Commands and complex patches remain unverified. Provider completion
          // is observation only and cannot prove the host postcondition.
          this.safeUnknown(
            prepared,
            status === 'completed'
              ? 'host_postcondition_unavailable'
              : `provider_${status}_after_dispatch`
          )
        }
        this.pushEvent(
          record,
          item.type === 'commandExecution' ? 'command' : 'file_change',
          `${prepared.intent.operation} ended; outcome needs verification`
        )
      } catch (error) {
        if (!isTerminalActionState(prepared.attempt.state)) {
          this.safeUnknown(prepared, 'verification_failed')
        }
        this.pushEvent(record, 'error', errorMessage(error))
      }
    }
  }

  private async finishTurn(
    record: TaskRecord,
    status: string,
    items: readonly JsonValue[]
  ): Promise<void> {
    for (const value of items) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        await this.settleItem(record, value as Record<string, unknown>)
      }
    }
    for (const attempts of record.actionItems.values()) {
      for (const prepared of attempts) {
        if (prepared.attempt.state === 'dispatched' || prepared.attempt.state === 'observed') {
          this.safeUnknown(prepared, 'turn_ended_without_verification')
        } else if (prepared.attempt.state === 'intent' || prepared.attempt.state === 'approved') {
          try {
            this.blockAndSave(prepared, 'turn_ended_before_dispatch')
            this.options.actions.cancelApproval(prepared, 'turn_ended_before_dispatch')
          } catch {
            // A concurrent approval resolution owns the terminal transition.
          }
        }
      }
    }
    const actionStates = [...record.actionItems.values()].flatMap((entries) =>
      entries.map((entry) => entry.attempt.state)
    )
    const terminal: CodexTerminalState = actionStates.includes('unknown_outcome')
      ? 'unknown_outcome'
      : actionStates.includes('blocked')
        ? 'blocked'
        : actionStates.includes('denied')
          ? 'blocked'
          : status === 'completed'
            ? 'success'
            : 'blocked'
    const rowState = status === 'completed' && terminal === 'success' ? 'done' : 'failed'
    const summary =
      terminal === 'unknown_outcome'
        ? 'A workspace action may have run, but its outcome could not be verified.'
        : terminal === 'success'
          ? record.actionItems.size > 0
            ? 'The approved workspace actions were verified.'
            : 'The Codex task completed without a host-approved write.'
          : 'The Codex task stopped without a verified result.'
    this.finishRecord(record, rowState, terminal, summary)
  }

  private finishRecord(
    record: TaskRecord,
    state: 'done' | 'failed' | 'cancelled',
    terminal: CodexTerminalState,
    summary: string
  ): void {
    if (record.row.state !== 'running') return
    if (record.timer) clearTimeout(record.timer)
    record.timer = null
    record.row.state = state
    record.row.terminal = terminal
    record.row.spokenSummary = summary
    this.pushEvent(record, state === 'failed' ? 'turn_failed' : 'turn_completed', summary)
    this.emitTask(record)
    if (record.row.threadId) this.threads.delete(record.row.threadId)
    for (const [turnId, task] of this.turns) if (task === record) this.turns.delete(turnId)
    record.activeTurnId = null
    record.filePatches.clear()
    record.fileVerificationPlans.clear()
    record.toolCalls.clear()
  }

  private safeUnknown(prepared: PreparedAction, code: string): void {
    try {
      this.unknownAndSave(prepared, code)
    } catch {
      // The attempt may have settled concurrently; never replay it.
    }
  }

  private blockAndSave(prepared: PreparedAction, code: string): void {
    if (this.receiptedAttempts.has(prepared.attempt.attemptId)) return
    this.options.actions.markBlockedAndSaveReceipt(prepared, code)
    this.receiptedAttempts.add(prepared.attempt.attemptId)
  }

  private unknownAndSave(prepared: PreparedAction, code: string): void {
    if (this.receiptedAttempts.has(prepared.attempt.attemptId)) return
    this.options.actions.markUnknownAndSaveReceipt(prepared, code)
    this.receiptedAttempts.add(prepared.attempt.attemptId)
  }

  private verifyAndSave(prepared: PreparedAction, displaySummary?: string): void {
    if (this.receiptedAttempts.has(prepared.attempt.attemptId)) return
    this.options.actions.markVerifiedAndSaveReceipt(prepared, displaySummary)
    this.receiptedAttempts.add(prepared.attempt.attemptId)
  }

  private enqueueSettlement(record: TaskRecord, operation: () => Promise<void>): void {
    const next = record.settlementChain.then(operation, operation)
    record.settlementChain = next.catch((error) => {
      this.pushEvent(record, 'error', `Postcondition verification failed: ${errorMessage(error)}`)
    })
  }

  private pushEvent(record: TaskRecord, kind: CodexEventRow['kind'], summary: string): void {
    const event: CodexEventRow = { at: Date.now(), kind, summary: truncate(summary, 500) }
    record.row.events = [...record.row.events, event].slice(-MAX_EVENT_ROWS)
    if (this.options.accountBinding() === record.accountId) {
      for (const listener of this.eventListeners) {
        try {
          listener(record.row.taskId, event)
        } catch {
          // Renderer listeners cannot alter task or approval lifecycle.
        }
      }
    }
    this.emitTask(record)
  }

  private emitTask(record: TaskRecord): void {
    if (this.options.accountBinding() !== record.accountId) return
    for (const listener of this.taskListeners) {
      try {
        listener(record.row)
      } catch {
        // Renderer listeners cannot alter task or approval lifecycle.
      }
    }
  }
}

function requireText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required`)
  const normalized = value.trim()
  if (normalized.length > max) throw new Error(`${name} is too long`)
  return normalized
}

function requireRequestId(value: string | number): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('requestId must be a safe integer')
    return
  }
  if (
    value.length === 0 ||
    value.length > 512 ||
    value !== value.trim() ||
    hasControlCharacters(value)
  ) {
    throw new Error('requestId is not a bounded normalized identifier')
  }
}

function assistantDispatchKey(
  call: AssistantCodexToolCall,
  binding: AssistantCodexBinding
): string {
  return [
    binding.accountId,
    binding.principalId,
    binding.providerGeneration,
    binding.threadId,
    binding.turnId,
    call.callId
  ].join('\u0000')
}

function sameAssistantBinding(
  current: AssistantCodexBinding | null,
  expected: AssistantCodexBinding
): boolean {
  return (
    current?.processEpoch === expected.processEpoch &&
    current.accountId === expected.accountId &&
    current.principalId === expected.principalId &&
    current.providerGeneration === expected.providerGeneration &&
    current.threadId === expected.threadId &&
    current.turnId === expected.turnId
  )
}

function sameAssistantTurn(
  binding: AssistantCodexBinding,
  generation: string,
  threadId: string,
  turnId: string
): boolean {
  return (
    binding.providerGeneration === generation &&
    binding.threadId === threadId &&
    binding.turnId === turnId
  )
}

function assistantDispatchFailureMessage(error: unknown): string {
  const message = errorMessage(error)
  if (/already running/iu.test(message)) {
    return 'One Codex task is already running. Wait for it to finish or cancel it in the Codex panel.'
  }
  if (/account|context|folder|scope|workspace|generation/iu.test(message)) {
    return 'The selected Codex folder or assistant context changed. Ask the user to choose the folder again.'
  }
  return 'Codex could not start the bounded task. No workspace result is being claimed.'
}

function workspaceToolLabel(tool: ValidatedWorkspaceToolCall['tool']): string {
  if (tool === 'list_files') return 'file listing'
  if (tool === 'read_text') return 'text read'
  if (tool === 'search_text') return 'literal search'
  return 'text write'
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value as number)))
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function appendBounded(current: string, delta: string, max: number): string {
  if (current.length >= max) return current
  return current + delta.slice(0, max - current.length)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function commandApprovalLabel(command: string | null | undefined): string {
  const text = command?.replace(/\s+/g, ' ').trim()
  return text ? `Run command: ${truncate(text, 180)}` : 'Run a workspace command'
}

function fileApprovalLabel(
  reason: string | null | undefined,
  affectedPaths: readonly string[],
  workspace: string
): string {
  const paths = affectedPaths
    .slice(0, 4)
    .map((path) => relative(workspace, path) || '.')
    .join(', ')
  const overflow = affectedPaths.length > 4 ? ` +${affectedPaths.length - 4} more` : ''
  const text = reason?.replace(/\s+/g, ' ').trim()
  const detail = paths ? `${paths}${overflow}` : 'workspace files'
  return text ? truncate(`Change ${detail}: ${text}`, 240) : truncate(`Change ${detail}`, 240)
}

async function commandDenialReason(
  scope: WorkspaceScope,
  cwd: string,
  params: CommandExecutionApprovalParams
): Promise<string | null> {
  if (params.networkApprovalContext != null) return 'network_access_not_supported'
  if (params.proposedExecpolicyAmendment != null) return 'execpolicy_amendment_not_supported'
  if (params.proposedNetworkPolicyAmendments != null) {
    return 'network_policy_amendment_not_supported'
  }
  if (params.additionalPermissions != null) return 'permission_expansion_not_supported'
  if (params.environmentId != null) return 'non_local_command_environment'
  const command = params.command
  const actions = params.commandActions
  if (!command || !actions || actions.length !== 1) return 'command_actions_not_exact'
  const [action] = actions
  if (action.type === 'unknown') return 'unknown_command_action'
  if (action.command !== command) {
    return 'command_action_mismatch'
  }
  const commandTarget = conservativelySafeCommandTarget(action, cwd)
  if (!commandTarget) return 'unsafe_command_action'

  const actionPath = action.type === 'read' ? action.path : (action.path ?? cwd)
  try {
    const safePath = await assertPathInsideScope(scope, resolve(cwd, actionPath))
    const safeCommandTarget = await assertPathInsideScope(scope, commandTarget)
    if (safeCommandTarget !== safePath) return 'command_action_path_mismatch'
    if (isSensitiveWorkspacePath(scope, safePath)) return 'sensitive_workspace_path'
  } catch {
    return 'command_action_outside_workspace'
  }
  return null
}

function conservativelySafeCommandTarget(
  action: Exclude<CommandAction, { type: 'unknown' }>,
  cwd: string
): string | null {
  const tokens = literalCommandTokens(action.command)
  if (!tokens) return null
  const executable = tokens[0] ?? ''
  if (action.type === 'read') {
    if (
      !['cat', 'head', 'tail', 'wc'].includes(executable) ||
      tokens.length !== 2 ||
      isOptionLike(tokens[1])
    ) {
      return null
    }
    return resolve(cwd, tokens[1]!)
  }
  if (action.type === 'listFiles') {
    if (executable !== 'ls' || tokens.length > 2 || isOptionLike(tokens[1])) return null
    return resolve(cwd, tokens[1] ?? cwd)
  }
  if (action.type === 'search') {
    if (!['rg', 'grep'].includes(executable)) return null
    if (
      !action.query ||
      tokens.length !== 3 ||
      tokens[1] !== action.query ||
      isOptionLike(tokens[1]) ||
      isOptionLike(tokens[2])
    ) {
      return null
    }
    return resolve(cwd, tokens[2]!)
  }
  return null
}

function isOptionLike(value: string | undefined): boolean {
  return value != null && (value.startsWith('-') || value.startsWith('+'))
}

function literalCommandTokens(command: string): readonly string[] | null {
  // A command needing quoting, escaping, expansion, or non-space separators is outside policy.
  const tokens = command.split(' ')
  if (tokens.length === 0 || tokens.some((token) => !/^[A-Za-z0-9._/,:@+-]+$/u.test(token))) {
    return null
  }
  return tokens
}

async function validatePatchPaths(
  scope: WorkspaceScope,
  changes: readonly FileUpdateChange[]
): Promise<readonly string[]> {
  if (changes.length === 0 || changes.length > MAX_PATCH_CHANGES) {
    throw new Error('File change patch has an invalid number of changes')
  }
  const paths = new Set<string>()
  for (const change of changes) {
    const safePath = await assertProposedPathInsideScope(scope, change.path)
    if (isSensitiveWorkspacePath(scope, safePath)) {
      throw new Error('File change targets a protected credential or repository-control path')
    }
    paths.add(safePath)
    if (change.kind.type === 'update' && change.kind.move_path) {
      const safeMovePath = await assertProposedPathInsideScope(scope, change.kind.move_path)
      if (isSensitiveWorkspacePath(scope, safeMovePath)) {
        throw new Error('File move targets a protected credential or repository-control path')
      }
      paths.add(safeMovePath)
    }
  }
  return [...paths]
}

async function captureFileVerificationPlan(
  scope: WorkspaceScope,
  patch: CapturedPatch
): Promise<FileVerificationPlan> {
  const paths = await validatePatchPaths(scope, patch.changes)
  const binding = {
    itemId: patch.itemId,
    turnId: patch.turnId,
    patchFingerprint: patch.fingerprint,
    paths
  }
  if (patch.changes.length !== 1) {
    return { ...binding, kind: 'unknown', reason: 'multiple_file_changes_unverifiable' }
  }
  const [change] = patch.changes
  if (change.kind.type === 'update') {
    return {
      ...binding,
      kind: 'unknown',
      reason: change.kind.move_path ? 'file_move_unverifiable' : 'file_update_unverifiable'
    }
  }
  const expected = Buffer.from(change.diff, 'utf8')
  if (expected.byteLength > MAX_VERIFICATION_FILE_BYTES) {
    return { ...binding, kind: 'unknown', reason: 'verification_content_oversized' }
  }

  try {
    const path = paths[0]!
    if (change.kind.type === 'add') {
      const before = await lstatOrNull(path)
      if (before) {
        return {
          ...binding,
          kind: 'unknown',
          reason: before.isSymbolicLink() ? 'add_target_is_symlink' : 'add_target_was_not_absent'
        }
      }
      return { ...binding, kind: 'add', path, expected }
    }

    const before = await readStableRegularFile(path)
    if (!before.ok) return { ...binding, kind: 'unknown', reason: before.reason }
    if (!before.bytes.equals(expected)) {
      return { ...binding, kind: 'unknown', reason: 'delete_precontent_mismatch' }
    }
    return { ...binding, kind: 'delete', path, preIdentity: before.identity }
  } catch {
    return { ...binding, kind: 'unknown', reason: 'verification_snapshot_failed' }
  }
}

async function revalidateVerificationPlanBeforeDispatch(
  scope: WorkspaceScope,
  plan: FileVerificationPlan
): Promise<FileVerificationPlan> {
  for (const path of plan.paths) {
    if ((await assertProposedPathInsideScope(scope, path)) !== path) {
      throw new Error('Verification path changed before dispatch')
    }
  }
  if (plan.kind === 'unknown') return plan
  const binding = {
    itemId: plan.itemId,
    turnId: plan.turnId,
    patchFingerprint: plan.patchFingerprint,
    paths: plan.paths
  }
  try {
    const current = await lstatOrNull(plan.path)
    if (plan.kind === 'add') {
      return current
        ? { ...binding, kind: 'unknown', reason: 'add_target_raced_before_dispatch' }
        : plan
    }
    if (!current || !current.isFile() || current.isSymbolicLink()) {
      return { ...binding, kind: 'unknown', reason: 'delete_target_changed_before_dispatch' }
    }
    return sameStableFile(identityFromStats(current), plan.preIdentity)
      ? plan
      : { ...binding, kind: 'unknown', reason: 'delete_target_raced_before_dispatch' }
  } catch {
    return { ...binding, kind: 'unknown', reason: 'verification_revalidation_failed' }
  }
}

async function verifyFilePostcondition(
  scope: WorkspaceScope,
  plan: FileVerificationPlan
): Promise<VerificationResult> {
  if (plan.kind === 'unknown') return { verified: false, reason: plan.reason }
  try {
    await revalidateWorkspaceScope(scope)
    const path = await assertProposedPathInsideScope(scope, plan.path)
    if (path !== plan.path) return { verified: false, reason: 'verification_path_changed' }
    if (plan.kind === 'delete') {
      return (await lstatOrNull(path)) === null
        ? { verified: true, reason: 'delete_absence_verified' }
        : { verified: false, reason: 'delete_target_still_exists' }
    }
    const after = await readStableRegularFile(path)
    if (!after.ok) return { verified: false, reason: after.reason }
    return after.bytes.equals(plan.expected)
      ? { verified: true, reason: 'add_content_verified' }
      : { verified: false, reason: 'add_content_mismatch' }
  } catch {
    return { verified: false, reason: 'postcondition_read_failed' }
  }
}

async function readStableRegularFile(path: string): Promise<StableFileRead> {
  let pathBefore: BigIntStats
  try {
    pathBefore = await lstat(path, { bigint: true })
  } catch (error) {
    return {
      ok: false,
      reason:
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'file_is_absent' : 'file_lstat_failed'
    }
  }
  if (pathBefore.isSymbolicLink()) return { ok: false, reason: 'file_is_symlink' }
  if (!pathBefore.isFile()) return { ok: false, reason: 'file_is_not_regular' }
  if (pathBefore.nlink !== 1n) return { ok: false, reason: 'file_has_multiple_links' }
  if (pathBefore.size > BigInt(MAX_VERIFICATION_FILE_BYTES)) {
    return { ok: false, reason: 'verification_file_oversized' }
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      !sameStableFile(identityFromStats(pathBefore), identityFromStats(opened))
    ) {
      return { ok: false, reason: 'file_changed_while_opening' }
    }
    const bytes = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (read.bytesRead === 0) return { ok: false, reason: 'file_truncated_while_reading' }
      offset += read.bytesRead
    }
    const extra = Buffer.alloc(1)
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      return { ok: false, reason: 'file_grew_while_reading' }
    }
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(path, { bigint: true })
    const openedIdentity = identityFromStats(opened)
    if (
      !after.isFile() ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameStableFile(openedIdentity, identityFromStats(after)) ||
      !sameStableFile(openedIdentity, identityFromStats(pathAfter))
    ) {
      return { ok: false, reason: 'file_raced_while_reading' }
    }
    return { ok: true, bytes, identity: openedIdentity }
  } catch (error) {
    return {
      ok: false,
      reason:
        (error as NodeJS.ErrnoException).code === 'ELOOP'
          ? 'file_became_symlink'
          : 'bounded_file_read_failed'
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function lstatOrNull(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function identityFromStats(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameStableFile(left: FileIdentity, right: FileIdentity): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function fingerprintCompletedChanges(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const changes: FileUpdateChange[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const change = entry as Record<string, unknown>
    if (typeof change.path !== 'string' || typeof change.diff !== 'string') return null
    if (!change.kind || typeof change.kind !== 'object' || Array.isArray(change.kind)) return null
    const kind = change.kind as Record<string, unknown>
    if (kind.type === 'add' || kind.type === 'delete') {
      changes.push({ path: change.path, diff: change.diff, kind: { type: kind.type } })
    } else if (kind.type === 'update') {
      if (
        kind.move_path !== undefined &&
        kind.move_path !== null &&
        typeof kind.move_path !== 'string'
      ) {
        return null
      }
      changes.push({
        path: change.path,
        diff: change.diff,
        kind: { type: 'update', move_path: (kind.move_path as string | null | undefined) ?? null }
      })
    } else {
      return null
    }
  }
  return createHash('sha256').update(serializeFileChanges(changes)).digest('hex')
}

function serializeFileChanges(changes: readonly FileUpdateChange[]): string {
  return JSON.stringify(
    changes.map((change) => ({
      path: change.path,
      kind:
        change.kind.type === 'update'
          ? { type: 'update', move_path: change.kind.move_path }
          : { type: change.kind.type },
      diff: change.diff
    }))
  )
}

async function assertProposedPathInsideScope(
  scope: WorkspaceScope,
  proposedPath: string
): Promise<string> {
  if (!proposedPath || proposedPath.includes('\0')) throw new Error('Patch path is invalid')
  await revalidateWorkspaceScope(scope)
  const candidate = resolve(scope.realpath, proposedPath)
  if (pathEscapes(scope.realpath, candidate)) throw new Error('Patch path escapes the workspace')

  try {
    await assertPathInsideScope(scope, candidate)
    return candidate
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  let ancestor = dirname(candidate)
  while (ancestor !== dirname(ancestor)) {
    try {
      const canonicalAncestor = await realpath(ancestor)
      if (pathEscapes(scope.realpath, canonicalAncestor)) {
        throw new Error('Patch path traverses a symlink outside the workspace')
      }
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      ancestor = dirname(ancestor)
    }
  }
  throw new Error('Patch path has no trusted workspace ancestor')
}

function pathEscapes(root: string, candidate: string): boolean {
  const offset = relative(root, candidate)
  return isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`)
}

function isSensitiveWorkspacePath(scope: WorkspaceScope, candidate: string): boolean {
  const segments = relative(scope.realpath, candidate)
    .split(/[\\/]/u)
    .map((segment) => segment.toLowerCase())
  return segments.some(
    (segment) =>
      segment === '.git' ||
      segment === '.env' ||
      segment.startsWith('.env.') ||
      segment === '.npmrc' ||
      segment === '.pypirc' ||
      segment === 'credentials' ||
      segment === 'id_rsa' ||
      segment === 'id_ed25519'
  )
}

function approvalDenialMessage(reason: string): string {
  return `Action declined by Jarvis safety policy (${reason})`
}

function isTerminalActionState(state: PreparedAction['attempt']['state']): boolean {
  return (
    state === 'denied' || state === 'verified' || state === 'blocked' || state === 'unknown_outcome'
  )
}

function actionKey(turnId: string, itemId: string): string {
  return `${turnId}\0${itemId}`
}

export function taskPromptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex')
}
