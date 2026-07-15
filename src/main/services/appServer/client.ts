import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  AppServerError,
  AppServerProtocolError,
  AppServerRequestError,
  AppServerStateError,
  AppServerTimeoutError
} from './errors'
import { buildMinimalChildEnvironment, prepareIsolatedCodexHome } from './environment'
import { verifyCodexExecutableVersion, type ResolvedCodexExecutable } from './executable'
import {
  BoundedJsonLineDecoder,
  DEFAULT_MAX_PROTOCOL_LINE_BYTES,
  redactAppServerText
} from './jsonLines'
import {
  isJsonObject,
  parseInboundEnvelope,
  validateClientResult,
  type ClientMethod,
  type ClientParams,
  type ClientResult,
  type CommandAction,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
  type FileChangeApprovalParams,
  type FileChangeApprovalResponse,
  type FileUpdateChange,
  type JsonObject,
  type JsonRpcInboundEnvelope,
  type NotificationMap,
  type NotificationMethod,
  type RequestId,
  type ServerRequestMethod,
  type ServerRequestParams,
  type ServerRequestResult,
  type CommandExecutionApprovalParams,
  type CommandExecutionApprovalResponse,
  CODEX_PROTOCOL_VERSION
} from './protocol'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000
const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 10 * 60_000
const DEFAULT_STOP_TIMEOUT_MS = 3_000
const DEFAULT_MAX_STDERR_BYTES = 2 * 1024 * 1024
const SERVER_REQUEST_RESOLVED = Symbol('server-request-resolved')
const MAX_DYNAMIC_TOOL_ARGUMENT_BYTES = 256 * 1024
const MAX_DYNAMIC_TOOL_RESULT_BYTES = 256 * 1024
const MAX_DYNAMIC_TOOL_CONTENT_ITEMS = 32
const MAX_DYNAMIC_TOOL_TEXT_LENGTH = 64 * 1024
const MAX_COMPLETED_SERVER_REQUEST_IDS = 4_096

export type AppServerState = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'

export interface AppServerReadyEvent {
  kind: 'ready'
  generation: string
  userAgent: string
  codexHome: string
}

export type AppServerLifecycleEvent =
  | { kind: 'starting'; generation: string }
  | AppServerReadyEvent
  | { kind: 'restarting'; previousGeneration: string | null; reason: string }
  | { kind: 'protocol-error'; generation: string; message: string }
  | {
      kind: 'exited'
      generation: string
      code: number | null
      signal: NodeJS.Signals | null
      expected: boolean
      restartable: boolean
      stderr: string
    }

export interface AppServerNotification<M extends NotificationMethod = NotificationMethod> {
  method: M
  params: NotificationMap[M]
  generation: string
}

export interface ServerRequestContext {
  requestId: RequestId
  generation: string
  receivedAt: number
  signal: AbortSignal
}

export type ServerRequestHandlers = {
  [M in ServerRequestMethod]?: (
    params: ServerRequestParams<M>,
    context: ServerRequestContext
  ) => Promise<ServerRequestResult<M>> | ServerRequestResult<M>
}

export interface AppServerLogger {
  debug?(message: string): void
  warn?(message: string): void
  error?(message: string): void
}

export interface AppServerClientOptions {
  executable: ResolvedCodexExecutable
  codexHome: string
  client: {
    name: string
    title: string | null
    version: string
  }
  requestTimeoutMs?: number
  initializeTimeoutMs?: number
  serverRequestTimeoutMs?: number
  stopTimeoutMs?: number
  maxProtocolLineBytes?: number
  maxStderrBytes?: number
  verifyExecutableOnStart?: boolean
  handlers?: ServerRequestHandlers
  logger?: AppServerLogger
  spawnProcess?: typeof spawn
}

interface PendingRequest {
  generation: string
  method: ClientMethod
  timer: NodeJS.Timeout
  resolve(value: unknown): void
  reject(error: Error): void
}

interface GenerationRuntime {
  id: string
  child: ChildProcessWithoutNullStreams
  decoder: BoundedJsonLineDecoder
  expectedExit: boolean
  stderrBytes: number
  stderrChunks: string[]
  stderrOverflowed: boolean
}

interface ActiveServerRequest {
  controller: AbortController
  responseStarted: boolean
}

type LifecycleListener = (event: AppServerLifecycleEvent) => void
type NotificationListener<M extends NotificationMethod> = (event: AppServerNotification<M>) => void
type AnyNotificationListener = (event: AppServerNotification) => void
type WildcardNotificationListener = (event: {
  method: string
  params: unknown
  generation: string
}) => void

/**
 * Generation-tagged, newline-delimited app-server client. It owns process and
 * correlation lifecycle only; policy, approval identity, and write journaling
 * remain host responsibilities.
 */
export class JarvisAppServer {
  private readonly options: Required<
    Pick<
      AppServerClientOptions,
      | 'requestTimeoutMs'
      | 'initializeTimeoutMs'
      | 'serverRequestTimeoutMs'
      | 'stopTimeoutMs'
      | 'maxProtocolLineBytes'
      | 'maxStderrBytes'
      | 'verifyExecutableOnStart'
    >
  > &
    AppServerClientOptions

  private current: GenerationRuntime | null = null
  private currentState: AppServerState = 'idle'
  private isolatedCodexHome: string | null = null
  private requestSequence = 0
  private pending = new Map<RequestId, PendingRequest>()
  private lifecycleListeners = new Set<LifecycleListener>()
  private notificationListeners = new Map<NotificationMethod, Set<AnyNotificationListener>>()
  private wildcardNotificationListeners = new Set<WildcardNotificationListener>()
  private serverRequests = new Map<string, Map<RequestId, ActiveServerRequest>>()
  private completedServerRequestIds = new Map<string, Set<RequestId>>()
  private writeChain: Promise<void> = Promise.resolve()

  constructor(options: AppServerClientOptions) {
    this.options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      initializeTimeoutMs: options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
      serverRequestTimeoutMs: options.serverRequestTimeoutMs ?? DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
      stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      maxProtocolLineBytes: options.maxProtocolLineBytes ?? DEFAULT_MAX_PROTOCOL_LINE_BYTES,
      maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
      verifyExecutableOnStart: options.verifyExecutableOnStart ?? true
    }
  }

  get state(): AppServerState {
    return this.currentState
  }

  get generation(): string | null {
    return this.current?.id ?? null
  }

  onLifecycle(listener: LifecycleListener): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  subscribe<M extends NotificationMethod>(
    method: M,
    listener: NotificationListener<M>
  ): () => void {
    let listeners = this.notificationListeners.get(method)
    if (!listeners) {
      listeners = new Set<AnyNotificationListener>()
      this.notificationListeners.set(method, listeners)
    }
    listeners.add(listener as AnyNotificationListener)
    return () => listeners?.delete(listener as AnyNotificationListener)
  }

  subscribeAll(listener: WildcardNotificationListener): () => void {
    this.wildcardNotificationListeners.add(listener)
    return () => this.wildcardNotificationListeners.delete(listener)
  }

  async start(): Promise<AppServerReadyEvent> {
    if (this.currentState === 'starting' || this.currentState === 'ready') {
      throw new AppServerStateError(`Cannot start app-server while ${this.currentState}`)
    }
    if (this.current) {
      throw new AppServerStateError('Cannot start app-server before the prior process exits')
    }

    this.currentState = 'starting'
    const generation = randomUUID()
    this.emitLifecycle({ kind: 'starting', generation })

    try {
      this.isolatedCodexHome = await prepareIsolatedCodexHome(this.options.codexHome)
      if (this.options.verifyExecutableOnStart) {
        await verifyCodexExecutableVersion(this.options.executable, {
          codexHome: this.isolatedCodexHome
        })
      }

      const spawnProcess = this.options.spawnProcess ?? spawn
      const child = spawnProcess(this.options.executable.path, ['app-server', '--stdio'], {
        env: buildMinimalChildEnvironment(this.isolatedCodexHome),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      }) as ChildProcessWithoutNullStreams

      const runtime: GenerationRuntime = {
        id: generation,
        child,
        decoder: new BoundedJsonLineDecoder({
          generation,
          maxLineBytes: this.options.maxProtocolLineBytes
        }),
        expectedExit: false,
        stderrBytes: 0,
        stderrChunks: [],
        stderrOverflowed: false
      }
      this.current = runtime
      this.attachProcess(runtime)
      await this.waitForSpawn(runtime)

      const initialized = await this.requestInternal(
        'initialize',
        {
          clientInfo: this.options.client,
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: false
          }
        },
        this.options.initializeTimeoutMs,
        generation
      )

      const reportedHome = await realpath(resolve(initialized.codexHome))
      if (reportedHome !== this.isolatedCodexHome) {
        throw new AppServerProtocolError(
          'App-server initialized with an unexpected CODEX_HOME',
          generation
        )
      }
      const escapedVersion = CODEX_PROTOCOL_VERSION.replaceAll('.', '\\.')
      if (!new RegExp(`\\b${escapedVersion}\\b`).test(initialized.userAgent)) {
        throw new AppServerProtocolError(
          `App-server initialize response does not report Codex ${CODEX_PROTOCOL_VERSION}`,
          generation
        )
      }

      await this.sendNotificationInternal('initialized', undefined, generation)
      this.assertCurrentGeneration(generation)
      this.currentState = 'ready'
      const ready: AppServerReadyEvent = {
        kind: 'ready',
        generation,
        userAgent: initialized.userAgent,
        codexHome: initialized.codexHome
      }
      this.emitLifecycle(ready)
      return ready
    } catch (error) {
      const cause = toError(error)
      if (this.current?.id === generation) this.failGeneration(generation, cause)
      else this.currentState = 'failed'
      throw cause
    }
  }

  async restart(reason: string): Promise<AppServerReadyEvent> {
    const previousGeneration = this.generation
    this.emitLifecycle({ kind: 'restarting', previousGeneration, reason })
    await this.stop()
    return this.start()
  }

  async stop(): Promise<void> {
    const runtime = this.current
    if (!runtime) {
      this.currentState = 'stopped'
      return
    }

    this.currentState = 'stopping'
    runtime.expectedExit = true
    this.rejectGeneration(runtime.id, new AppServerError('App-server is stopping'))
    this.abortServerRequests(runtime.id)
    await settleWithin(this.writeChain, Math.min(500, this.options.stopTimeoutMs))
    runtime.child.stdin.end()

    const closed = waitForClose(runtime.child)
    this.signalProcess(runtime.child, 'SIGTERM')
    const stopped = await settleWithin(closed, this.options.stopTimeoutMs)
    if (!stopped) {
      this.signalProcess(runtime.child, 'SIGKILL')
      await settleWithin(closed, 1_000)
    }

    if (this.current?.id === runtime.id) {
      this.current = null
      this.currentState = 'stopped'
    }
  }

  request<M extends Exclude<ClientMethod, 'initialize'>>(
    method: M,
    params: ClientParams<M>,
    options: { timeoutMs?: number } = {}
  ): Promise<ClientResult<M>> {
    if (this.currentState !== 'ready' || !this.current) {
      throw new AppServerStateError(
        `Cannot call ${method} while app-server is ${this.currentState}`
      )
    }
    return this.requestInternal(
      method,
      params,
      options.timeoutMs ?? this.options.requestTimeoutMs,
      this.current.id
    )
  }

  private requestInternal<M extends ClientMethod>(
    method: M,
    params: ClientParams<M>,
    timeoutMs: number,
    generation: string
  ): Promise<ClientResult<M>> {
    this.assertCurrentGeneration(generation)
    const id = `${generation}:${++this.requestSequence}`

    const promise = new Promise<ClientResult<M>>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(new AppServerTimeoutError(method, timeoutMs))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, {
        generation,
        method,
        timer,
        resolve: (value) => {
          try {
            resolveRequest(validateClientResult(method, value))
          } catch (error) {
            rejectRequest(
              new AppServerProtocolError(
                `Invalid ${method} result: ${toError(error).message}`,
                generation,
                { cause: error }
              )
            )
          }
        },
        reject: rejectRequest
      })
    })

    const envelope: JsonObject = {
      id,
      method,
      ...(params === undefined ? {} : { params: params as JsonValueForWire })
    }
    void this.enqueueMessage(envelope, generation).catch((error) => {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(toError(error))
    })
    return promise
  }

  private sendNotificationInternal(
    method: string,
    params: JsonValueForWire | undefined,
    generation: string
  ): Promise<void> {
    return this.enqueueMessage({ method, ...(params === undefined ? {} : { params }) }, generation)
  }

  private attachProcess(runtime: GenerationRuntime): void {
    runtime.child.stdout.on('data', (chunk: Buffer) => {
      if (this.current?.id !== runtime.id) return
      try {
        const messages = runtime.decoder.push(chunk)
        for (const message of messages) this.handleInbound(runtime.id, message)
      } catch (error) {
        this.failGeneration(runtime.id, toError(error))
      }
    })

    runtime.child.stderr.on('data', (chunk: Buffer) => {
      if (this.current?.id !== runtime.id || runtime.stderrOverflowed) return
      runtime.stderrBytes += chunk.length
      if (runtime.stderrBytes > this.options.maxStderrBytes) {
        runtime.stderrOverflowed = true
        this.failGeneration(
          runtime.id,
          new AppServerProtocolError(
            `App-server stderr exceeded ${this.options.maxStderrBytes} bytes`,
            runtime.id
          )
        )
        return
      }
      // Keep bounded stderr private to main until the complete stream can be
      // redacted. Per-chunk redaction can miss a credential split at a chunk boundary.
      runtime.stderrChunks.push(chunk.toString('utf8'))
      if (runtime.stderrChunks.length >= 256) {
        runtime.stderrChunks = [runtime.stderrChunks.join('')]
      }
    })

    runtime.child.on('error', (error) => {
      if (this.current?.id === runtime.id) this.failGeneration(runtime.id, error)
    })

    runtime.child.on('close', (code, signal) => {
      if (this.current?.id === runtime.id) {
        try {
          for (const message of runtime.decoder.finish()) this.handleInbound(runtime.id, message)
        } catch (error) {
          this.emitLifecycle({
            kind: 'protocol-error',
            generation: runtime.id,
            message: toError(error).message
          })
        }
      }
      this.handleExit(runtime, code, signal)
    })
  }

  private waitForSpawn(runtime: GenerationRuntime): Promise<void> {
    if (runtime.child.pid !== undefined) return Promise.resolve()
    return new Promise((resolveSpawn, rejectSpawn) => {
      const onSpawn = (): void => {
        cleanup()
        resolveSpawn()
      }
      const onError = (error: Error): void => {
        cleanup()
        rejectSpawn(error)
      }
      const cleanup = (): void => {
        runtime.child.off('spawn', onSpawn)
        runtime.child.off('error', onError)
      }
      runtime.child.once('spawn', onSpawn)
      runtime.child.once('error', onError)
    })
  }

  private handleInbound(generation: string, raw: unknown): void {
    if (this.current?.id !== generation) return
    let envelope: JsonRpcInboundEnvelope
    try {
      envelope = parseInboundEnvelope(raw)
    } catch (error) {
      this.failGeneration(
        generation,
        new AppServerProtocolError(toError(error).message, generation, { cause: error })
      )
      return
    }

    if ('id' in envelope && 'result' in envelope) {
      this.resolveResponse(generation, envelope.id, envelope.result)
      return
    }
    if ('id' in envelope && 'error' in envelope) {
      this.rejectResponse(generation, envelope.id, envelope.error)
      return
    }
    if ('id' in envelope && 'method' in envelope) {
      void this.handleServerRequest(generation, envelope.id, envelope.method, envelope.params)
      return
    }
    if ('method' in envelope) {
      this.emitNotification(generation, envelope.method, envelope.params)
    }
  }

  private resolveResponse(generation: string, id: RequestId, value: unknown): void {
    const pending = this.pending.get(id)
    if (!pending || pending.generation !== generation) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(value)
  }

  private rejectResponse(
    generation: string,
    id: RequestId,
    error: { code: number; message: string; data?: unknown }
  ): void {
    const pending = this.pending.get(id)
    if (!pending || pending.generation !== generation) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.reject(
      new AppServerRequestError(pending.method, {
        code: error.code,
        message: redactAppServerText(error.message)
      })
    )
  }

  private async handleServerRequest(
    generation: string,
    id: RequestId,
    method: string,
    params: unknown
  ): Promise<void> {
    const controller = new AbortController()
    const request: ActiveServerRequest = { controller, responseStarted: false }
    if (!this.trackServerRequest(generation, id, request)) {
      this.options.logger?.warn?.(`Ignored duplicate server request identifier ${String(id)}`)
      return
    }
    try {
      const context: ServerRequestContext = {
        requestId: id,
        generation,
        receivedAt: Date.now(),
        signal: controller.signal
      }

      if (method === 'item/commandExecution/requestApproval') {
        const parsed = parseCommandApproval(params)
        const handler = this.options.handlers?.[method]
        const result: CommandExecutionApprovalResponse = handler
          ? await withTimeout(
              Promise.resolve(handler(parsed, context)),
              this.options.serverRequestTimeoutMs,
              method,
              () => controller.abort()
            )
          : { decision: 'decline' }
        assertApprovalDecision(result.decision)
        await this.sendServerRequestResult(id, { decision: result.decision }, generation, request)
      } else if (method === 'item/fileChange/requestApproval') {
        const parsed = parseFileApproval(params)
        const handler = this.options.handlers?.[method]
        const result: FileChangeApprovalResponse = handler
          ? await withTimeout(
              Promise.resolve(handler(parsed, context)),
              this.options.serverRequestTimeoutMs,
              method,
              () => controller.abort()
            )
          : { decision: 'decline' }
        assertApprovalDecision(result.decision)
        await this.sendServerRequestResult(id, { decision: result.decision }, generation, request)
      } else if (method === 'item/tool/call') {
        const parsed = parseDynamicToolCall(params)
        const handler = this.options.handlers?.[method]
        const result: DynamicToolCallResponse = handler
          ? await withTimeout(
              Promise.resolve(handler(parsed, context)),
              this.options.serverRequestTimeoutMs,
              method,
              () => controller.abort()
            )
          : dynamicToolFailureResponse('This Jarvis tool is unavailable.')
        const validated = validateDynamicToolResponse(result)
        await this.sendServerRequestResult(
          id,
          dynamicToolResponseForWire(validated),
          generation,
          request
        )
      } else {
        await this.sendErrorResponse(
          id,
          -32601,
          'Server request method is not allowlisted',
          generation,
          request
        )
      }
    } catch (error) {
      if (controller.signal.reason === SERVER_REQUEST_RESOLVED || request.responseStarted) return
      if (
        this.current?.id !== generation ||
        (this.currentState !== 'ready' && this.currentState !== 'starting')
      ) {
        return
      }
      this.options.logger?.warn?.(
        `Server request ${method} failed: ${redactAppServerText(toError(error).message)}`
      )
      if (
        method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval'
      ) {
        await this.sendServerRequestResult(id, { decision: 'decline' }, generation, request)
      } else if (method === 'item/tool/call') {
        await this.sendServerRequestResult(
          id,
          dynamicToolResponseForWire(
            dynamicToolFailureResponse('Jarvis could not safely handle this tool call.')
          ),
          generation,
          request
        )
      } else {
        await this.sendErrorResponse(
          id,
          -32603,
          'Jarvis could not safely review this request',
          generation,
          request
        )
      }
    } finally {
      this.untrackServerRequest(generation, id, request)
    }
  }

  private sendServerRequestResult(
    id: RequestId,
    result: JsonObject,
    generation: string,
    request: ActiveServerRequest
  ): Promise<void> {
    if (!this.claimServerRequestResponse(generation, id, request)) return Promise.resolve()
    return this.enqueueMessage({ id, result }, generation)
  }

  private sendErrorResponse(
    id: RequestId,
    code: number,
    message: string,
    generation: string,
    request: ActiveServerRequest
  ): Promise<void> {
    if (!this.claimServerRequestResponse(generation, id, request)) return Promise.resolve()
    return this.enqueueMessage({ id, error: { code, message } }, generation)
  }

  private emitNotification(generation: string, method: string, params: unknown): void {
    const known = isKnownNotificationMethod(method)
    const parsed = known ? parseKnownNotification(method, params) : params
    if (method === 'serverRequest/resolved') {
      const resolved = parseKnownNotification('serverRequest/resolved', params)
      this.resolveServerRequest(generation, resolved.requestId)
    }

    const wildcardEvent = { method, params: parsed, generation }
    for (const listener of this.wildcardNotificationListeners) {
      try {
        listener(wildcardEvent)
      } catch (error) {
        this.options.logger?.warn?.(
          `Wildcard notification listener failed: ${redactAppServerText(toError(error).message)}`
        )
      }
    }

    if (!known) return
    const listeners = this.notificationListeners.get(method)
    if (!listeners || listeners.size === 0) return
    const event = { method, params: parsed, generation } as AppServerNotification
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        this.options.logger?.warn?.(
          `${method} notification listener failed: ${redactAppServerText(toError(error).message)}`
        )
      }
    }
  }

  private enqueueMessage(message: JsonObject, generation: string): Promise<void> {
    const write = async (): Promise<void> => {
      this.assertCurrentGeneration(generation)
      const line = `${JSON.stringify(message)}\n`
      if (Buffer.byteLength(line) > this.options.maxProtocolLineBytes) {
        throw new AppServerProtocolError(
          `Outgoing protocol line exceeded ${this.options.maxProtocolLineBytes} bytes`,
          generation
        )
      }
      const child = this.current!.child
      await new Promise<void>((resolveWrite, rejectWrite) => {
        child.stdin.write(line, (error) => {
          if (error) rejectWrite(error)
          else resolveWrite()
        })
      })
    }
    const queued = this.writeChain.then(write, write)
    this.writeChain = queued.catch(() => undefined)
    return queued
  }

  private failGeneration(generation: string, error: Error): void {
    const runtime = this.current
    if (!runtime || runtime.id !== generation) return
    if (runtime.expectedExit) return
    this.currentState = 'failed'
    this.emitLifecycle({ kind: 'protocol-error', generation, message: error.message })
    this.rejectGeneration(generation, error)
    this.abortServerRequests(generation)
    this.signalProcess(runtime.child, 'SIGTERM')
  }

  private handleExit(
    runtime: GenerationRuntime,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    const stderr = redactAppServerText(runtime.stderrChunks.join('')).slice(-64 * 1024)
    this.rejectGeneration(
      runtime.id,
      new AppServerError(
        runtime.expectedExit
          ? 'App-server stopped'
          : `App-server exited unexpectedly (${signal ?? String(code)})`
      )
    )
    this.abortServerRequests(runtime.id)

    if (this.current?.id === runtime.id) {
      this.current = null
      this.currentState = runtime.expectedExit ? 'stopped' : 'failed'
    }
    this.emitLifecycle({
      kind: 'exited',
      generation: runtime.id,
      code,
      signal,
      expected: runtime.expectedExit,
      restartable: !runtime.expectedExit,
      stderr
    })
  }

  private rejectGeneration(generation: string, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }

  private trackServerRequest(
    generation: string,
    requestId: RequestId,
    request: ActiveServerRequest
  ): boolean {
    if (this.completedServerRequestIds.get(generation)?.has(requestId)) return false
    let requests = this.serverRequests.get(generation)
    if (!requests) {
      requests = new Map<RequestId, ActiveServerRequest>()
      this.serverRequests.set(generation, requests)
    }
    if (requests.has(requestId)) return false
    requests.set(requestId, request)
    return true
  }

  private untrackServerRequest(
    generation: string,
    requestId: RequestId,
    request: ActiveServerRequest
  ): void {
    const requests = this.serverRequests.get(generation)
    if (!requests) return
    if (requests.get(requestId) === request) {
      requests.delete(requestId)
      this.rememberCompletedServerRequest(generation, requestId)
    }
    if (requests.size === 0) this.serverRequests.delete(generation)
  }

  private rememberCompletedServerRequest(generation: string, requestId: RequestId): void {
    let completed = this.completedServerRequestIds.get(generation)
    if (!completed) {
      completed = new Set<RequestId>()
      this.completedServerRequestIds.set(generation, completed)
    }
    completed.add(requestId)
    if (completed.size > MAX_COMPLETED_SERVER_REQUEST_IDS) {
      const oldest = completed.values().next().value
      if (oldest !== undefined) completed.delete(oldest)
    }
  }

  private claimServerRequestResponse(
    generation: string,
    requestId: RequestId,
    request: ActiveServerRequest
  ): boolean {
    if (this.serverRequests.get(generation)?.get(requestId) !== request) return false
    if (request.responseStarted || request.controller.signal.reason === SERVER_REQUEST_RESOLVED) {
      return false
    }
    request.responseStarted = true
    return true
  }

  private resolveServerRequest(generation: string, requestId: RequestId): void {
    const request = this.serverRequests.get(generation)?.get(requestId)
    if (request) request.controller.abort(SERVER_REQUEST_RESOLVED)
  }

  private abortServerRequests(generation: string): void {
    const requests = this.serverRequests.get(generation)
    this.serverRequests.delete(generation)
    this.completedServerRequestIds.delete(generation)
    if (!requests) return
    for (const request of requests.values()) request.controller.abort()
  }

  private signalProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (child.killed) return
    try {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        process.kill(-child.pid, signal)
      } else {
        child.kill(signal)
      }
    } catch {
      try {
        child.kill(signal)
      } catch {
        // Process already exited.
      }
    }
  }

  private assertCurrentGeneration(generation: string): void {
    if (!this.current || this.current.id !== generation) {
      throw new AppServerStateError('App-server generation is no longer current')
    }
  }

  private emitLifecycle(event: AppServerLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event)
      } catch (error) {
        this.options.logger?.warn?.(
          `Lifecycle listener failed: ${redactAppServerText(toError(error).message)}`
        )
      }
    }
  }
}

type JsonValueForWire = string | number | boolean | null | JsonObject | readonly JsonValueForWire[]

function parseCommandApproval(value: unknown): CommandExecutionApprovalParams {
  const params = requireObject(value, 'command approval params')
  return {
    threadId: requireBoundedString(params.threadId, 'threadId', 512),
    turnId: requireBoundedString(params.turnId, 'turnId', 512),
    itemId: requireBoundedString(params.itemId, 'itemId', 512),
    startedAtMs: requireInteger(params.startedAtMs, 'startedAtMs'),
    approvalId: optionalNullableBoundedString(params.approvalId, 'approvalId', 512),
    environmentId:
      optionalNullableBoundedString(params.environmentId, 'environmentId', 512) ?? null,
    reason: optionalNullableBoundedString(params.reason, 'reason', 4_096),
    networkApprovalContext: parseOptionalNetworkApprovalContext(params.networkApprovalContext),
    command: optionalNullableBoundedString(params.command, 'command', 32_000),
    cwd: optionalNullableBoundedString(params.cwd, 'cwd', 8_192),
    commandActions: parseOptionalCommandActions(params.commandActions),
    proposedExecpolicyAmendment: parseOptionalStringArray(
      params.proposedExecpolicyAmendment,
      'proposedExecpolicyAmendment',
      64,
      2_048
    ),
    proposedNetworkPolicyAmendments: parseOptionalNetworkPolicyAmendments(
      params.proposedNetworkPolicyAmendments
    ),
    additionalPermissions:
      params.additionalPermissions === undefined
        ? undefined
        : (params.additionalPermissions as JsonValueForWire),
    availableDecisions: optionalArray(params.availableDecisions, 'availableDecisions')
  }
}

function parseFileApproval(value: unknown): FileChangeApprovalParams {
  const params = requireObject(value, 'file approval params')
  return {
    threadId: requireBoundedString(params.threadId, 'threadId', 512),
    turnId: requireBoundedString(params.turnId, 'turnId', 512),
    itemId: requireBoundedString(params.itemId, 'itemId', 512),
    startedAtMs: requireInteger(params.startedAtMs, 'startedAtMs'),
    reason: optionalNullableBoundedString(params.reason, 'reason', 4_096),
    grantRoot: optionalNullableBoundedString(params.grantRoot, 'grantRoot', 8_192)
  }
}

function parseDynamicToolCall(value: unknown): DynamicToolCallParams {
  const params = requireObject(value, 'dynamic tool call params')
  requireExactObjectKeys(
    params,
    ['arguments', 'callId', 'namespace', 'threadId', 'tool', 'turnId'],
    'dynamic tool call params'
  )
  const namespace =
    params.namespace === null
      ? null
      : requireDynamicToolIdentifier(params.namespace, 'namespace', 64)
  const argumentsValue = params.arguments
  requireBoundedJson(argumentsValue, 'arguments', MAX_DYNAMIC_TOOL_ARGUMENT_BYTES)
  return {
    threadId: requireNonEmptyBoundedString(params.threadId, 'threadId', 512),
    turnId: requireNonEmptyBoundedString(params.turnId, 'turnId', 512),
    callId: requireNonEmptyBoundedString(params.callId, 'callId', 512),
    namespace,
    tool: requireDynamicToolIdentifier(params.tool, 'tool', 128),
    arguments: argumentsValue
  }
}

function validateDynamicToolResponse(value: unknown): DynamicToolCallResponse {
  const response = requireObject(value, 'dynamic tool response')
  if (typeof response.success !== 'boolean') {
    throw new AppServerProtocolError('dynamic tool response success must be a boolean', null)
  }
  if (!Array.isArray(response.contentItems)) {
    throw new AppServerProtocolError('dynamic tool response contentItems must be an array', null)
  }
  if (response.contentItems.length > MAX_DYNAMIC_TOOL_CONTENT_ITEMS) {
    throw new AppServerProtocolError(
      `dynamic tool response contentItems exceeds ${MAX_DYNAMIC_TOOL_CONTENT_ITEMS} entries`,
      null
    )
  }
  const contentItems = response.contentItems.map((value, index) => {
    const item = requireObject(value, `dynamic tool response contentItems[${index}]`)
    if (item.type !== 'inputText') {
      throw new AppServerProtocolError(
        `dynamic tool response contentItems[${index}].type is not supported`,
        null
      )
    }
    return {
      type: 'inputText' as const,
      text: requireBoundedString(
        item.text,
        `dynamic tool response contentItems[${index}].text`,
        MAX_DYNAMIC_TOOL_TEXT_LENGTH
      )
    }
  })
  const normalized: DynamicToolCallResponse = {
    contentItems,
    success: response.success
  }
  requireBoundedJson(normalized, 'dynamic tool response', MAX_DYNAMIC_TOOL_RESULT_BYTES)
  return normalized
}

function dynamicToolFailureResponse(text: string): DynamicToolCallResponse {
  return { contentItems: [{ type: 'inputText', text }], success: false }
}

function dynamicToolResponseForWire(response: DynamicToolCallResponse): JsonObject {
  const contentItems: JsonObject[] = response.contentItems.map((item) => ({
    type: item.type,
    text: item.text
  }))
  return { contentItems, success: response.success }
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new AppServerProtocolError(`${label} must be an object`, null)
  return value
}

function requireExactObjectKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string
): void {
  const keys = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new AppServerProtocolError(`${label} contains missing or additional properties`, null)
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new AppServerProtocolError(`${label} must be a string`, null)
  }
  return value
}

function requireBoundedString(value: unknown, label: string, max: number): string {
  const text = requireString(value, label)
  if (text.length > max) {
    throw new AppServerProtocolError(`${label} exceeds ${max} characters`, null)
  }
  return text
}

function requireNonEmptyBoundedString(value: unknown, label: string, max: number): string {
  const text = requireBoundedString(value, label, max)
  if (text.length === 0) {
    throw new AppServerProtocolError(`${label} must not be empty`, null)
  }
  return text
}

function requireDynamicToolIdentifier(value: unknown, label: string, max: number): string {
  const identifier = requireNonEmptyBoundedString(value, label, max)
  if (!/^[a-zA-Z0-9_-]+$/.test(identifier)) {
    throw new AppServerProtocolError(`${label} is not a valid dynamic tool identifier`, null)
  }
  return identifier
}

function requireNullableBoundedString(value: unknown, label: string, max: number): string | null {
  if (value === null) return null
  return requireBoundedString(value, label, max)
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AppServerProtocolError(`${label} must be an integer`, null)
  }
  return value
}

function requirePositiveInteger(value: unknown, label: string, max: number): number {
  const integer = requireInteger(value, label)
  if (integer <= 0 || integer > max) {
    throw new AppServerProtocolError(`${label} is outside the supported range`, null)
  }
  return integer
}

function requireBoundedJson(value: unknown, label: string, maxBytes: number): void {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new AppServerProtocolError(`${label} must be JSON serializable`, null)
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new AppServerProtocolError(`${label} exceeds ${maxBytes} bytes`, null)
  }
}

function parseRealtimeAudioChunk(
  value: unknown
): NotificationMap['thread/realtime/outputAudio/delta']['audio'] {
  const audio = requireObject(value, 'audio')
  const samplesPerChannel = audio.samplesPerChannel
  return {
    data: requireBoundedString(audio.data, 'audio.data', 512 * 1024),
    sampleRate: requirePositiveInteger(audio.sampleRate, 'audio.sampleRate', 384_000),
    numChannels: requirePositiveInteger(audio.numChannels, 'audio.numChannels', 32),
    samplesPerChannel:
      samplesPerChannel === null
        ? null
        : requirePositiveInteger(samplesPerChannel, 'audio.samplesPerChannel', 10_000_000),
    itemId: requireNullableBoundedString(audio.itemId, 'audio.itemId', 512)
  }
}

function optionalNullableString(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return requireString(value, label)
}

function optionalNullableBoundedString(
  value: unknown,
  label: string,
  max: number
): string | null | undefined {
  const text = optionalNullableString(value, label)
  if (typeof text === 'string' && text.length > max) {
    throw new AppServerProtocolError(`${label} exceeds ${max} characters`, null)
  }
  return text
}

function optionalArray(
  value: unknown,
  label: string
): readonly JsonValueForWire[] | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!Array.isArray(value)) throw new AppServerProtocolError(`${label} must be an array`, null)
  return value as readonly JsonValueForWire[]
}

function parseOptionalCommandActions(value: unknown): readonly CommandAction[] | null | undefined {
  if (value === undefined || value === null) return value
  if (!Array.isArray(value)) {
    throw new AppServerProtocolError('commandActions must be an array', null)
  }
  if (value.length > 64) {
    throw new AppServerProtocolError('commandActions exceeds 64 entries', null)
  }
  return value.map((entry, index) => parseCommandAction(entry, `commandActions[${index}]`))
}

function parseCommandAction(value: unknown, label: string): CommandAction {
  const action = requireObject(value, label)
  const type = requireString(action.type, `${label}.type`)
  const command = requireBoundedString(action.command, `${label}.command`, 32_000)
  if (type === 'read') {
    return {
      type,
      command,
      name: requireBoundedString(action.name, `${label}.name`, 4_096),
      path: requireBoundedString(action.path, `${label}.path`, 8_192)
    }
  }
  if (type === 'listFiles') {
    return {
      type,
      command,
      path: optionalNullableBoundedString(action.path, `${label}.path`, 8_192) ?? null
    }
  }
  if (type === 'search') {
    return {
      type,
      command,
      query: optionalNullableBoundedString(action.query, `${label}.query`, 8_192) ?? null,
      path: optionalNullableBoundedString(action.path, `${label}.path`, 8_192) ?? null
    }
  }
  if (type === 'unknown') return { type, command }
  throw new AppServerProtocolError(`${label}.type is not supported`, null)
}

function parseOptionalNetworkApprovalContext(
  value: unknown
): CommandExecutionApprovalParams['networkApprovalContext'] {
  if (value === undefined || value === null) return value
  const context = requireObject(value, 'networkApprovalContext')
  const protocol = requireString(context.protocol, 'networkApprovalContext.protocol')
  if (!['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(protocol)) {
    throw new AppServerProtocolError('networkApprovalContext.protocol is invalid', null)
  }
  return {
    host: requireBoundedString(context.host, 'networkApprovalContext.host', 2_048),
    protocol: protocol as 'http' | 'https' | 'socks5Tcp' | 'socks5Udp'
  }
}

function parseOptionalStringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxItemLength: number
): readonly string[] | null | undefined {
  if (value === undefined || value === null) return value
  if (!Array.isArray(value)) throw new AppServerProtocolError(`${label} must be an array`, null)
  if (value.length > maxItems) {
    throw new AppServerProtocolError(`${label} exceeds ${maxItems} entries`, null)
  }
  return value.map((item, index) => requireBoundedString(item, `${label}[${index}]`, maxItemLength))
}

function parseOptionalNetworkPolicyAmendments(
  value: unknown
): CommandExecutionApprovalParams['proposedNetworkPolicyAmendments'] {
  if (value === undefined || value === null) return value
  if (!Array.isArray(value)) {
    throw new AppServerProtocolError('proposedNetworkPolicyAmendments must be an array', null)
  }
  if (value.length > 64) {
    throw new AppServerProtocolError('proposedNetworkPolicyAmendments exceeds 64 entries', null)
  }
  return value.map((entry, index) => {
    const amendment = requireObject(entry, `proposedNetworkPolicyAmendments[${index}]`)
    const action = requireString(
      amendment.action,
      `proposedNetworkPolicyAmendments[${index}].action`
    )
    if (action !== 'allow' && action !== 'deny') {
      throw new AppServerProtocolError(
        `proposedNetworkPolicyAmendments[${index}].action is invalid`,
        null
      )
    }
    return {
      host: requireBoundedString(
        amendment.host,
        `proposedNetworkPolicyAmendments[${index}].host`,
        2_048
      ),
      action
    }
  })
}

function assertApprovalDecision(value: unknown): asserts value is 'accept' | 'decline' | 'cancel' {
  if (value !== 'accept' && value !== 'decline' && value !== 'cancel') {
    throw new AppServerProtocolError('Approval handler returned an invalid decision', null)
  }
}

const KNOWN_NOTIFICATION_METHODS: ReadonlySet<string> = new Set<NotificationMethod>([
  'account/login/completed',
  'account/updated',
  'app/list/updated',
  'thread/started',
  'turn/started',
  'turn/completed',
  'item/agentMessage/delta',
  'item/fileChange/patchUpdated',
  'item/completed',
  'serverRequest/resolved',
  'thread/realtime/started',
  'thread/realtime/itemAdded',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/error',
  'thread/realtime/closed',
  'error'
])

function isKnownNotificationMethod(value: string): value is NotificationMethod {
  return KNOWN_NOTIFICATION_METHODS.has(value)
}

function parseKnownNotification<M extends NotificationMethod>(
  method: M,
  value: unknown
): NotificationMap[M] {
  const params = requireObject(value, `${method} notification`)
  switch (method) {
    case 'account/login/completed':
      optionalNullableString(params.loginId, 'loginId')
      if (typeof params.success !== 'boolean') throw new Error('success must be a boolean')
      optionalNullableString(params.error, 'error')
      break
    case 'account/updated':
      optionalNullableString(params.authMode, 'authMode')
      optionalNullableString(params.planType, 'planType')
      break
    case 'app/list/updated':
      if (!Array.isArray(params.data)) throw new Error('data must be an array')
      break
    case 'thread/started':
      requireString(requireObject(params.thread, 'thread').id, 'thread.id')
      break
    case 'turn/started':
    case 'turn/completed':
      requireString(params.threadId, 'threadId')
      requireString(requireObject(params.turn, 'turn').id, 'turn.id')
      break
    case 'item/agentMessage/delta':
      requireBoundedString(params.threadId, 'threadId', 512)
      requireBoundedString(params.turnId, 'turnId', 512)
      requireBoundedString(params.itemId, 'itemId', 512)
      requireBoundedString(params.delta, 'delta', 256 * 1024)
      break
    case 'item/fileChange/patchUpdated':
      return parseFileChangePatchUpdated(params) as NotificationMap[M]
    case 'item/completed':
      return parseItemCompleted(params) as NotificationMap[M]
    case 'serverRequest/resolved':
      requireBoundedString(params.threadId, 'threadId', 512)
      if (typeof params.requestId === 'string') {
        requireBoundedString(params.requestId, 'requestId', 512)
      } else if (!(typeof params.requestId === 'number' && Number.isInteger(params.requestId))) {
        throw new AppServerProtocolError('requestId must be a string or integer', null)
      }
      break
    case 'thread/realtime/started': {
      const version = requireBoundedString(params.version, 'version', 16)
      if (version !== 'v1' && version !== 'v2') {
        throw new AppServerProtocolError('version must be v1 or v2', null)
      }
      return {
        threadId: requireBoundedString(params.threadId, 'threadId', 512),
        realtimeSessionId: requireNullableBoundedString(
          params.realtimeSessionId,
          'realtimeSessionId',
          512
        ),
        version
      } as NotificationMap[M]
    }
    case 'thread/realtime/itemAdded':
      if (params.item === undefined) {
        throw new AppServerProtocolError('item is required', null)
      }
      requireBoundedJson(params.item, 'item', 256 * 1024)
      return {
        threadId: requireBoundedString(params.threadId, 'threadId', 512),
        item: params.item
      } as NotificationMap[M]
    case 'thread/realtime/transcript/delta':
      return {
        threadId: requireBoundedString(params.threadId, 'threadId', 512),
        role: requireBoundedString(params.role, 'role', 64),
        delta: requireBoundedString(params.delta, 'delta', 256 * 1024)
      } as NotificationMap[M]
    case 'thread/realtime/transcript/done':
      return {
        threadId: requireBoundedString(params.threadId, 'threadId', 512),
        role: requireBoundedString(params.role, 'role', 64),
        text: requireBoundedString(params.text, 'text', 256 * 1024)
      } as NotificationMap[M]
    case 'thread/realtime/outputAudio/delta':
      return {
        threadId: requireBoundedString(params.threadId, 'threadId', 512),
        audio: parseRealtimeAudioChunk(params.audio)
      } as NotificationMap[M]
    case 'thread/realtime/sdp':
      return {
        threadId: requireBoundedString(params.threadId, 'threadId', 512),
        sdp: requireBoundedString(params.sdp, 'sdp', 256 * 1024)
      } as NotificationMap[M]
    case 'thread/realtime/error':
      return {
        threadId: requireBoundedString(params.threadId, 'threadId', 512),
        message: requireBoundedString(params.message, 'message', 16 * 1024)
      } as NotificationMap[M]
    case 'thread/realtime/closed':
      return {
        threadId: requireBoundedString(params.threadId, 'threadId', 512),
        reason: requireNullableBoundedString(params.reason, 'reason', 4_096)
      } as NotificationMap[M]
    case 'error':
      break
  }
  return params as unknown as NotificationMap[M]
}

function parseFileChangePatchUpdated(
  params: JsonObject
): NotificationMap['item/fileChange/patchUpdated'] {
  return {
    threadId: requireBoundedString(params.threadId, 'threadId', 512),
    turnId: requireBoundedString(params.turnId, 'turnId', 512),
    itemId: requireBoundedString(params.itemId, 'itemId', 512),
    changes: parseFileUpdateChanges(params.changes, 'changes')
  }
}

function parseItemCompleted(params: JsonObject): NotificationMap['item/completed'] {
  const item = requireObject(params.item, 'item')
  requireBoundedString(item.id, 'item.id', 512)
  const type = requireBoundedString(item.type, 'item.type', 128)
  if (type === 'commandExecution') {
    requireBoundedString(item.command, 'item.command', 32_000)
    requireBoundedString(item.cwd, 'item.cwd', 8_192)
    parseRequiredCommandActions(item.commandActions, 'item.commandActions')
    requireMutationStatus(item.status, 'item.status')
    if (item.exitCode !== undefined && item.exitCode !== null) {
      requireInteger(item.exitCode, 'item.exitCode')
    }
  } else if (type === 'fileChange') {
    parseFileUpdateChanges(item.changes, 'item.changes')
    requireMutationStatus(item.status, 'item.status')
  }
  return {
    threadId: requireBoundedString(params.threadId, 'threadId', 512),
    turnId: requireBoundedString(params.turnId, 'turnId', 512),
    item,
    completedAtMs: requireInteger(params.completedAtMs, 'completedAtMs')
  }
}

function parseRequiredCommandActions(value: unknown, label: string): readonly CommandAction[] {
  const actions = parseOptionalCommandActions(value)
  if (!actions) throw new AppServerProtocolError(`${label} must be an array`, null)
  return actions
}

function parseFileUpdateChanges(value: unknown, label: string): readonly FileUpdateChange[] {
  if (!Array.isArray(value)) throw new AppServerProtocolError(`${label} must be an array`, null)
  if (value.length > 256) {
    throw new AppServerProtocolError(`${label} exceeds 256 entries`, null)
  }
  return value.map((entry, index) => {
    const change = requireObject(entry, `${label}[${index}]`)
    const kindValue = requireObject(change.kind, `${label}[${index}].kind`)
    const type = requireString(kindValue.type, `${label}[${index}].kind.type`)
    let kind: FileUpdateChange['kind'] | null = null
    if (type === 'add' || type === 'delete') kind = { type }
    if (type === 'update') {
      kind = {
        type,
        move_path:
          optionalNullableBoundedString(
            kindValue.move_path,
            `${label}[${index}].kind.move_path`,
            8_192
          ) ?? null
      }
    }
    if (!kind) {
      throw new AppServerProtocolError(`${label}[${index}].kind.type is invalid`, null)
    }
    return {
      path: requireBoundedString(change.path, `${label}[${index}].path`, 8_192),
      kind,
      diff: requireBoundedString(change.diff, `${label}[${index}].diff`, 256 * 1024)
    }
  })
}

function requireMutationStatus(value: unknown, label: string): void {
  if (!['inProgress', 'completed', 'failed', 'declined'].includes(String(value))) {
    throw new AppServerProtocolError(`${label} is invalid`, null)
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.()
          reject(new AppServerTimeoutError(label, timeoutMs))
        }, timeoutMs)
        timer.unref()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function waitForClose(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveClose) => child.once('close', () => resolveClose()))
}

async function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
        timer.unref()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
