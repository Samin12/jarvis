import type { ActionCoordinator, PreparedAction } from '../actions/coordinator'
import { assembleReceipt } from '../actions/receiptAssembler'
import {
  COMPUTER_TOOL_NAMESPACE,
  isMacAppId,
  MAC_APPLICATION_CATALOG,
  OPEN_APPLICATION_TOOL_NAME,
  type MacAppId,
  type MacApplicationDefinition
} from './catalog'
import {
  DefaultMacApplicationExecutor,
  DefaultMacApplicationVerifier,
  type MacApplicationExecutor,
  type MacApplicationVerifier
} from './macAppLauncher'

const MAX_DEDUPLICATED_CALLS = 2_048

const TOOL_CALL_KEYS = ['arguments', 'callId', 'namespace', 'threadId', 'tool', 'turnId'] as const

export interface ComputerToolCallParams {
  namespace: string
  tool: string
  threadId: string
  turnId: string
  callId: string
  arguments: unknown
}

export interface ComputerActionBinding {
  readonly processEpoch: string
  readonly accountId: string
  readonly principalId: string
  readonly providerGeneration: string
  readonly threadId: string
  readonly turnId: string
}

export interface ComputerToolRequestContext {
  readonly rpcId: string
  readonly binding: ComputerActionBinding
  readonly currentBinding: () => ComputerActionBinding | null
  readonly signal: AbortSignal
}

export interface ComputerToolContentItem {
  type: 'inputText'
  text: string
}

export interface ComputerToolCallResult {
  contentItems: ComputerToolContentItem[]
  success: boolean
}

export interface ComputerActionServiceOptions {
  actions: ActionCoordinator
  executor?: MacApplicationExecutor
  verifier?: MacApplicationVerifier
  maxDeduplicatedCalls?: number
}

interface ValidatedCall {
  params: ComputerToolCallParams
  appId: MacAppId
  application: MacApplicationDefinition
}

interface DeduplicatedCall {
  fingerprint: string
  promise: Promise<ComputerToolCallResult>
}

export class ComputerActionService {
  private readonly actions: ActionCoordinator
  private readonly executor: MacApplicationExecutor
  private readonly verifier: MacApplicationVerifier
  private readonly maxDeduplicatedCalls: number
  private readonly calls = new Map<string, DeduplicatedCall>()

  constructor(options: ComputerActionServiceOptions) {
    this.actions = options.actions
    this.executor = options.executor ?? new DefaultMacApplicationExecutor()
    this.verifier = options.verifier ?? new DefaultMacApplicationVerifier()
    this.maxDeduplicatedCalls = Math.max(
      1,
      Math.min(options.maxDeduplicatedCalls ?? MAX_DEDUPLICATED_CALLS, 10_000)
    )
  }

  handleToolCall(
    input: unknown,
    context: ComputerToolRequestContext
  ): Promise<ComputerToolCallResult> {
    let call: ValidatedCall
    let boundContext: ComputerToolRequestContext
    try {
      call = validateToolCall(input)
      boundContext = snapshotRequestContext(context)
      validateRequestContext(call.params, boundContext)
      if (!isRequestCurrent(call.params, boundContext)) {
        return Promise.resolve(failureResult('The computer action context is no longer current.'))
      }
    } catch {
      return Promise.resolve(failureResult('The computer action request was rejected.'))
    }

    const deduplicationKey = callKey(call.params, boundContext.binding)
    const fingerprint = call.appId
    const existing = this.calls.get(deduplicationKey)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve(
          failureResult('A conflicting duplicate computer action was rejected.')
        )
      }
      return existing.promise
    }
    if (this.calls.size >= this.maxDeduplicatedCalls) {
      return Promise.resolve(
        failureResult(
          'The computer action safety cache is full. Restart Jarvis before trying again.'
        )
      )
    }

    const promise = this.execute(call, boundContext).catch(() =>
      failureResult('The computer action failed closed before a verified result.')
    )
    this.calls.set(deduplicationKey, { fingerprint, promise })
    return promise
  }

  private async execute(
    call: ValidatedCall,
    context: ComputerToolRequestContext
  ): Promise<ComputerToolCallResult> {
    let prepared: PreparedAction | undefined
    try {
      prepared = this.actions.prepare({
        accountId: context.binding.accountId,
        principalId: context.binding.principalId,
        capability: 'computer.app.open',
        operation: `Open ${call.application.displayName}`,
        target: call.application.applicationPath,
        arguments: {
          appId: call.appId,
          threadId: call.params.threadId,
          turnId: call.params.turnId,
          callId: call.params.callId
        },
        dataClassification: 'account',
        networkRequired: false,
        providerGeneration: context.binding.providerGeneration,
        mutating: true
      })

      if (prepared.policy.disposition === 'deny') {
        this.saveDeniedReceipt(
          prepared,
          `${call.application.displayName} was not opened because host policy denied the action.`
        )
        return failureResult(`${call.application.displayName} was not opened by host policy.`)
      }
      if (prepared.policy.disposition !== 'require_approval') {
        this.actions.markBlockedAndSaveReceipt(
          prepared,
          'approval_policy_missing',
          `${call.application.displayName} was not opened because explicit approval was unavailable.`
        )
        return failureResult(`${call.application.displayName} requires explicit approval.`)
      }

      try {
        await this.verifier.preflight(call.application, context.signal)
      } catch {
        return this.blockBeforeDispatch(
          prepared,
          call.application,
          context.signal.aborted ? 'request_aborted' : 'application_identity_preflight_failed'
        )
      }
      if (!isRequestCurrent(call.params, context)) {
        return this.blockBeforeDispatch(prepared, call.application, 'approval_context_changed')
      }

      let approved: boolean
      try {
        approved = await this.actions.requestApproval(
          prepared,
          {
            processEpoch: context.binding.processEpoch,
            rpcId: context.rpcId,
            threadId: call.params.threadId,
            turnId: call.params.turnId,
            itemId: call.params.callId
          },
          context.signal
        )
      } catch {
        return this.finishApprovalFailure(prepared, call.application)
      }
      if (!approved) {
        this.saveDeniedReceipt(
          prepared,
          `${call.application.displayName} was not opened because the approval was denied or expired.`
        )
        return failureResult(`${call.application.displayName} was not opened.`)
      }
      if (!isRequestCurrent(call.params, context)) {
        return this.blockBeforeDispatch(prepared, call.application, 'approval_context_changed')
      }

      try {
        await this.verifier.preflight(call.application, context.signal)
      } catch {
        return this.blockBeforeDispatch(
          prepared,
          call.application,
          context.signal.aborted ? 'request_aborted' : 'application_identity_changed'
        )
      }
      if (!isRequestCurrent(call.params, context)) {
        return this.blockBeforeDispatch(prepared, call.application, 'approval_context_changed')
      }

      this.actions.markDispatched(prepared, context.rpcId)
      if (!isRequestCurrent(call.params, context)) {
        return this.unknownAfterDispatch(
          prepared,
          call.application,
          'context_changed_after_dispatch'
        )
      }

      try {
        await this.executor.launch(call.application, context.signal)
      } catch {
        return this.unknownAfterDispatch(
          prepared,
          call.application,
          context.signal.aborted ? 'request_aborted_after_dispatch' : 'application_launch_failed'
        )
      }

      try {
        this.actions.markObserved(prepared, {
          providerRequestId: context.rpcId,
          providerResourceId: call.params.callId
        })
      } catch {
        return this.unknownAfterDispatch(prepared, call.application, 'launch_observation_failed')
      }
      if (!isRequestCurrent(call.params, context)) {
        return this.unknownAfterDispatch(prepared, call.application, 'context_changed_after_launch')
      }

      let verified: boolean
      try {
        verified = await this.verifier.verifyRunning(call.application, context.signal)
      } catch {
        return this.unknownAfterDispatch(
          prepared,
          call.application,
          context.signal.aborted ? 'request_aborted_during_verification' : 'verification_failed'
        )
      }
      if (!verified || !isRequestCurrent(call.params, context)) {
        return this.unknownAfterDispatch(
          prepared,
          call.application,
          verified ? 'context_changed_before_confirmation' : 'application_identity_unconfirmed'
        )
      }

      this.actions.markVerifiedAndSaveReceipt(
        prepared,
        `${call.application.displayName} was opened and its exact path and bundle identity were verified.`
      )
      return successResult(
        `${call.application.displayName} opened. Jarvis verified the exact application path and bundle identity.`
      )
    } catch {
      if (prepared) return this.finishUnexpected(prepared, call.application)
      return failureResult('The computer action failed closed before it could be prepared.')
    }
  }

  private finishApprovalFailure(
    prepared: PreparedAction,
    application: MacApplicationDefinition
  ): ComputerToolCallResult {
    if (prepared.attempt.state === 'denied') {
      this.saveDeniedReceipt(
        prepared,
        `${application.displayName} was not opened because the approval context was cancelled.`
      )
      return failureResult(`${application.displayName} was not opened.`)
    }
    return this.blockBeforeDispatch(prepared, application, 'approval_request_failed')
  }

  private finishUnexpected(
    prepared: PreparedAction,
    application: MacApplicationDefinition
  ): ComputerToolCallResult {
    if (prepared.attempt.state === 'dispatched' || prepared.attempt.state === 'observed') {
      return this.unknownAfterDispatch(prepared, application, 'computer_action_internal_failure')
    }
    if (prepared.attempt.state === 'intent' || prepared.attempt.state === 'approved') {
      return this.blockBeforeDispatch(prepared, application, 'computer_action_internal_failure')
    }
    if (prepared.attempt.state === 'denied') {
      try {
        this.saveDeniedReceipt(prepared, `${application.displayName} was not opened.`)
      } catch {
        // The failure response remains conservative if receipt persistence itself failed.
      }
    }
    return failureResult(`Jarvis could not verify that ${application.displayName} opened.`)
  }

  private blockBeforeDispatch(
    prepared: PreparedAction,
    application: MacApplicationDefinition,
    failureCode: string
  ): ComputerToolCallResult {
    this.actions.markBlockedAndSaveReceipt(
      prepared,
      failureCode,
      `${application.displayName} was not opened because its approved safety conditions were not met.`
    )
    return failureResult(`${application.displayName} was not opened.`)
  }

  private unknownAfterDispatch(
    prepared: PreparedAction,
    application: MacApplicationDefinition,
    failureCode: string
  ): ComputerToolCallResult {
    this.actions.markUnknownAndSaveReceipt(
      prepared,
      failureCode,
      `${application.displayName} may have opened, but Jarvis could not verify the exact application. Check the Mac before retrying.`
    )
    return failureResult(
      `${application.displayName} may have opened, but Jarvis could not verify it. Check the Mac before retrying.`
    )
  }

  private saveDeniedReceipt(prepared: PreparedAction, summary: string): void {
    this.actions.saveReceipt(assembleReceipt(prepared.attempt, summary))
  }
}

function validateToolCall(input: unknown): ValidatedCall {
  if (!isPlainObject(input)) throw new Error('Tool call must be a plain object')
  requireExactKeys(input, TOOL_CALL_KEYS)
  const params: ComputerToolCallParams = {
    namespace: requireBoundedId(input.namespace, 'namespace'),
    tool: requireBoundedId(input.tool, 'tool'),
    threadId: requireBoundedId(input.threadId, 'threadId'),
    turnId: requireBoundedId(input.turnId, 'turnId'),
    callId: requireBoundedId(input.callId, 'callId'),
    arguments: input.arguments
  }
  if (params.namespace !== COMPUTER_TOOL_NAMESPACE || params.tool !== OPEN_APPLICATION_TOOL_NAME) {
    throw new Error('Tool is outside the computer action allowlist')
  }
  if (!isPlainObject(params.arguments)) throw new Error('Tool arguments must be a plain object')
  requireExactKeys(params.arguments, ['appId'])
  if (!isMacAppId(params.arguments.appId)) throw new Error('Application is outside the allowlist')
  return {
    params,
    appId: params.arguments.appId,
    application: MAC_APPLICATION_CATALOG[params.arguments.appId]
  }
}

function validateRequestContext(
  params: ComputerToolCallParams,
  context: ComputerToolRequestContext
): void {
  requireBoundedId(context.rpcId, 'rpcId')
  const binding = context.binding
  requireBoundedId(binding.processEpoch, 'processEpoch')
  requireBoundedId(binding.accountId, 'accountId')
  requireBoundedId(binding.principalId, 'principalId')
  requireBoundedId(binding.providerGeneration, 'providerGeneration')
  requireBoundedId(binding.threadId, 'boundThreadId')
  requireBoundedId(binding.turnId, 'boundTurnId')
  if (binding.threadId !== params.threadId || binding.turnId !== params.turnId) {
    throw new Error('Tool call is outside its bound thread or turn')
  }
  if (!isAbortSignal(context.signal)) throw new Error('Abort signal is required')
}

function snapshotRequestContext(context: ComputerToolRequestContext): ComputerToolRequestContext {
  const binding: ComputerActionBinding = Object.freeze({
    processEpoch: context.binding.processEpoch,
    accountId: context.binding.accountId,
    principalId: context.binding.principalId,
    providerGeneration: context.binding.providerGeneration,
    threadId: context.binding.threadId,
    turnId: context.binding.turnId
  })
  const currentBinding = context.currentBinding.bind(context)
  return Object.freeze({
    rpcId: context.rpcId,
    binding,
    currentBinding: () => currentBinding(),
    signal: context.signal
  })
}

function isRequestCurrent(
  params: ComputerToolCallParams,
  context: ComputerToolRequestContext
): boolean {
  if (context.signal.aborted) return false
  let current: ComputerActionBinding | null
  try {
    current = context.currentBinding()
  } catch {
    return false
  }
  return (
    current !== null &&
    current.processEpoch === context.binding.processEpoch &&
    current.accountId === context.binding.accountId &&
    current.principalId === context.binding.principalId &&
    current.providerGeneration === context.binding.providerGeneration &&
    current.threadId === context.binding.threadId &&
    current.turnId === context.binding.turnId &&
    current.threadId === params.threadId &&
    current.turnId === params.turnId
  )
}

function callKey(params: ComputerToolCallParams, binding: ComputerActionBinding): string {
  return [
    binding.processEpoch,
    binding.accountId,
    binding.principalId,
    binding.providerGeneration,
    params.threadId,
    params.turnId,
    params.callId
  ].join('\u0000')
}

function requireBoundedId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty normalized string`)
  }
  if (value.length > 512 || value.includes('\0')) throw new Error(`${name} exceeds safety limits`)
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<AbortSignal>
  return (
    typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  )
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error('Object contains missing or additional properties')
  }
}

function successResult(text: string): ComputerToolCallResult {
  return { contentItems: [{ type: 'inputText', text }], success: true }
}

function failureResult(text: string): ComputerToolCallResult {
  return { contentItems: [{ type: 'inputText', text }], success: false }
}
