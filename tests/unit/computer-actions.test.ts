import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ActionCoordinator, ActionLedger } from '../../src/main/services/actions'
import {
  COMPUTER_TOOL_NAMESPACE,
  ComputerActionService,
  DefaultMacApplicationExecutor,
  DefaultMacApplicationVerifier,
  ExecFileCommandRunner,
  MAC_APPLICATION_CATALOG,
  MAC_APP_IDS,
  OPEN_APPLICATION_DYNAMIC_TOOL,
  OPEN_APPLICATION_TOOL_NAME,
  type ComputerActionBinding,
  type ComputerToolCallParams,
  type ComputerToolRequestContext,
  type ExecFileInvocationOptions,
  type FixedCommandResult,
  type FixedCommandRunner,
  type MacApplicationDefinition,
  type MacApplicationExecutor,
  type MacApplicationVerifier,
  type MacFixedExecutable
} from '../../src/main/services/computer'

const BASE_BINDING: ComputerActionBinding = {
  processEpoch: 'process-epoch-1',
  accountId: 'account-1',
  principalId: 'principal-1',
  providerGeneration: 'provider-generation-1',
  threadId: 'assistant-thread-1',
  turnId: 'turn-1'
}

class RecordingExecutor implements MacApplicationExecutor {
  readonly launches: MacApplicationDefinition[] = []
  shouldThrow = false

  async launch(application: MacApplicationDefinition, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('aborted')
    this.launches.push(application)
    if (this.shouldThrow) throw new Error('launch failed')
  }
}

class RecordingVerifier implements MacApplicationVerifier {
  readonly preflights: MacApplicationDefinition[] = []
  readonly verifications: MacApplicationDefinition[] = []
  preflightFailure = false
  verified = true

  async preflight(application: MacApplicationDefinition, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('aborted')
    this.preflights.push(application)
    if (this.preflightFailure) throw new Error('identity mismatch')
  }

  async verifyRunning(
    application: MacApplicationDefinition,
    signal: AbortSignal
  ): Promise<boolean> {
    if (signal.aborted) throw new Error('aborted')
    this.verifications.push(application)
    return this.verified
  }
}

class ScriptedRunner implements FixedCommandRunner {
  readonly calls: Array<{ executable: MacFixedExecutable; arguments_: string[] }> = []

  constructor(
    private readonly handler: (
      executable: MacFixedExecutable,
      arguments_: readonly string[]
    ) => FixedCommandResult
  ) {}

  async run(
    executable: MacFixedExecutable,
    arguments_: readonly string[],
    signal?: AbortSignal
  ): Promise<FixedCommandResult> {
    if (signal?.aborted) throw new Error('aborted')
    this.calls.push({ executable, arguments_: [...arguments_] })
    return this.handler(executable, arguments_)
  }
}

interface Harness {
  actions: ActionCoordinator
  executor: RecordingExecutor
  verifier: RecordingVerifier
  service: ComputerActionService
  context: ComputerToolRequestContext
  setCurrentBinding(binding: ComputerActionBinding | null): void
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-computer-actions-'))
  const ledger = new ActionLedger(join(directory, 'actions.sqlite3'))
  const actions = new ActionCoordinator(ledger)
  const executor = new RecordingExecutor()
  const verifier = new RecordingVerifier()
  let currentBinding: ComputerActionBinding | null = { ...BASE_BINDING }
  const controller = new AbortController()
  const context: ComputerToolRequestContext = {
    rpcId: 'rpc-1',
    binding: { ...BASE_BINDING },
    currentBinding: () => currentBinding,
    signal: controller.signal
  }
  const service = new ComputerActionService({ actions, executor, verifier })
  try {
    await run({
      actions,
      executor,
      verifier,
      service,
      context,
      setCurrentBinding(binding): void {
        currentBinding = binding
      }
    })
  } finally {
    actions.invalidateAll('test_cleanup')
    ledger.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

function toolCall(
  appId: 'calculator' | 'calendar' | 'notes' = 'calculator',
  overrides: Partial<ComputerToolCallParams> = {}
): ComputerToolCallParams {
  return {
    namespace: COMPUTER_TOOL_NAMESPACE,
    tool: OPEN_APPLICATION_TOOL_NAME,
    threadId: BASE_BINDING.threadId,
    turnId: BASE_BINDING.turnId,
    callId: 'call-1',
    arguments: { appId },
    ...overrides
  }
}

async function waitForApproval(actions: ActionCoordinator): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [approval] = actions.listApprovals()
    if (approval) return approval.approvalId
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for approval')
}

function decide(
  actions: ActionCoordinator,
  approvalId: string,
  decision: 'approve' | 'deny'
): void {
  actions.decide(approvalId, decision, {
    processEpoch: BASE_BINDING.processEpoch,
    accountId: BASE_BINDING.accountId,
    providerGeneration: BASE_BINDING.providerGeneration
  })
}

describe('computer application allowlist', () => {
  it('exposes only the three fixed app identities and an exact no-extras tool schema', () => {
    expect(MAC_APP_IDS).toEqual(['calculator', 'calendar', 'notes'])
    expect(MAC_APPLICATION_CATALOG).toEqual({
      calculator: {
        id: 'calculator',
        displayName: 'Calculator',
        applicationPath: '/System/Applications/Calculator.app',
        bundleId: 'com.apple.calculator'
      },
      calendar: {
        id: 'calendar',
        displayName: 'Calendar',
        applicationPath: '/System/Applications/Calendar.app',
        bundleId: 'com.apple.iCal'
      },
      notes: {
        id: 'notes',
        displayName: 'Notes',
        applicationPath: '/System/Applications/Notes.app',
        bundleId: 'com.apple.Notes'
      }
    })
    expect(OPEN_APPLICATION_DYNAMIC_TOOL.inputSchema).toMatchObject({
      type: 'object',
      required: ['appId'],
      additionalProperties: false,
      properties: { appId: { type: 'string', enum: ['calculator', 'calendar', 'notes'] } }
    })
  })

  it('rejects unknown apps, extra arguments, and extra protocol fields before an attempt exists', async () => {
    await withHarness(async ({ actions, executor, service, context, verifier }) => {
      const unknownApp = await service.handleToolCall(
        { ...toolCall(), arguments: { appId: 'terminal' } },
        context
      )
      const extraArgument = await service.handleToolCall(
        { ...toolCall(), arguments: { appId: 'calculator', command: '2+2' } },
        context
      )
      const extraProtocolField = await service.handleToolCall(
        { ...toolCall(), untrusted: true },
        context
      )

      expect(
        [unknownApp, extraArgument, extraProtocolField].every((result) => !result.success)
      ).toBe(true)
      expect(actions.listAttempts()).toEqual([])
      expect(actions.listApprovals()).toEqual([])
      expect(executor.launches).toEqual([])
      expect(verifier.preflights).toEqual([])
    })
  })
})

describe('ComputerActionService approval, execution, and receipts', () => {
  it('uses one bound approval and reports success only after exact verification', async () => {
    await withHarness(async ({ actions, executor, service, context, verifier }) => {
      const pending = service.handleToolCall(toolCall(), context)
      const approvalId = await waitForApproval(actions)

      const [approval] = actions.listApprovals()
      expect(approval).toMatchObject({
        approvalId,
        capability: 'computer.app.open',
        operation: 'Open Calculator',
        target: '/System/Applications/Calculator.app'
      })
      decide(actions, approvalId, 'approve')

      const result = await pending
      expect(result.success).toBe(true)
      expect(result.contentItems[0]?.text).toMatch(/verified the exact application path/i)
      expect(verifier.preflights).toHaveLength(2)
      expect(executor.launches).toEqual([MAC_APPLICATION_CATALOG.calculator])
      expect(verifier.verifications).toEqual([MAC_APPLICATION_CATALOG.calculator])

      const [attempt] = actions.listAttempts()
      expect(attempt).toMatchObject({
        state: 'verified',
        approvalId,
        providerRequestId: 'rpc-1',
        providerResourceId: 'call-1',
        verification: 'confirmed'
      })
      expect(actions.listReceipts(BASE_BINDING.principalId)).toEqual([
        expect.objectContaining({
          attemptId: attempt?.attemptId,
          terminal: 'success',
          verification: 'confirmed'
        })
      ])
    })
  })

  it('deduplicates the same call across RPC retries and rejects a conflicting duplicate', async () => {
    await withHarness(async ({ actions, executor, service, context }) => {
      const first = service.handleToolCall(toolCall(), context)
      const retry = service.handleToolCall(toolCall(), { ...context, rpcId: 'rpc-retry' })
      const conflict = await service.handleToolCall(toolCall('notes'), context)

      expect(retry).toBe(first)
      expect(conflict.success).toBe(false)
      expect(conflict.contentItems[0]?.text).toMatch(/conflicting duplicate/i)
      const approvalId = await waitForApproval(actions)
      expect(actions.listApprovals()).toHaveLength(1)
      decide(actions, approvalId, 'approve')

      const [firstResult, retryResult] = await Promise.all([first, retry])
      expect(firstResult).toEqual(retryResult)
      expect(firstResult.success).toBe(true)
      expect(executor.launches).toHaveLength(1)
      expect(actions.listAttempts()).toHaveLength(1)
      expect(actions.listReceipts(BASE_BINDING.principalId)).toHaveLength(1)
    })
  })

  it('blocks before approval when the installed app identity does not match', async () => {
    await withHarness(async ({ actions, executor, service, context, verifier }) => {
      verifier.preflightFailure = true

      const result = await service.handleToolCall(toolCall(), context)

      expect(result.success).toBe(false)
      expect(actions.listApprovals()).toEqual([])
      expect(executor.launches).toEqual([])
      expect(actions.listAttempts()[0]).toMatchObject({
        state: 'blocked',
        failureCode: 'application_identity_preflight_failed',
        verification: 'failed'
      })
      expect(actions.listReceipts(BASE_BINDING.principalId)[0]).toMatchObject({
        terminal: 'blocked',
        verification: 'failed'
      })
    })
  })

  it('records a denied receipt without dispatching', async () => {
    await withHarness(async ({ actions, executor, service, context }) => {
      const pending = service.handleToolCall(toolCall(), context)
      decide(actions, await waitForApproval(actions), 'deny')

      expect((await pending).success).toBe(false)
      expect(executor.launches).toEqual([])
      expect(actions.listAttempts()[0]).toMatchObject({
        state: 'denied',
        verification: 'unavailable'
      })
      expect(actions.listReceipts(BASE_BINDING.principalId)[0]).toMatchObject({
        terminal: 'denied',
        verification: 'unavailable'
      })
    })
  })

  it('fails closed if the request aborts while approval is pending', async () => {
    await withHarness(async ({ actions, executor, service, context }) => {
      const controller = new AbortController()
      const abortableContext = { ...context, signal: controller.signal }
      const pending = service.handleToolCall(toolCall(), abortableContext)
      await waitForApproval(actions)
      controller.abort()

      expect((await pending).success).toBe(false)
      expect(executor.launches).toEqual([])
      expect(actions.listAttempts()[0]?.state).toBe('denied')
      expect(actions.listReceipts(BASE_BINDING.principalId)[0]?.terminal).toBe('denied')
    })
  })

  it('fails closed when the bound turn changes after approval but before dispatch', async () => {
    await withHarness(async ({ actions, executor, service, context, setCurrentBinding }) => {
      const pending = service.handleToolCall(toolCall(), context)
      const approvalId = await waitForApproval(actions)
      decide(actions, approvalId, 'approve')
      setCurrentBinding({ ...BASE_BINDING, turnId: 'turn-2' })

      expect((await pending).success).toBe(false)
      expect(executor.launches).toEqual([])
      expect(actions.listAttempts()[0]).toMatchObject({
        state: 'blocked',
        failureCode: 'approval_context_changed'
      })
      expect(actions.listReceipts(BASE_BINDING.principalId)[0]?.terminal).toBe('blocked')
    })
  })

  it('snapshots the account, generation, turn, and RPC binding before asynchronous work', async () => {
    await withHarness(async ({ actions, executor, service }) => {
      const mutableBinding = { ...BASE_BINDING }
      const mutableContext = {
        rpcId: 'rpc-original',
        binding: mutableBinding,
        currentBinding: () => ({ ...BASE_BINDING }),
        signal: new AbortController().signal
      }
      const pending = service.handleToolCall(toolCall(), mutableContext)

      mutableBinding.accountId = 'substituted-account'
      mutableBinding.providerGeneration = 'substituted-generation'
      mutableBinding.turnId = 'substituted-turn'
      mutableContext.rpcId = 'rpc-substituted'

      decide(actions, await waitForApproval(actions), 'approve')

      expect((await pending).success).toBe(true)
      expect(executor.launches).toHaveLength(1)
      expect(actions.listAttempts()[0]).toMatchObject({
        accountId: BASE_BINDING.accountId,
        providerGeneration: BASE_BINDING.providerGeneration,
        providerRequestId: 'rpc-original'
      })
    })
  })

  it('records unknown outcome after dispatch when exact post-verification fails', async () => {
    await withHarness(async ({ actions, executor, service, context, verifier }) => {
      verifier.verified = false
      const pending = service.handleToolCall(toolCall(), context)
      decide(actions, await waitForApproval(actions), 'approve')

      const result = await pending
      expect(result.success).toBe(false)
      expect(result.contentItems[0]?.text).toMatch(/may have opened/i)
      expect(executor.launches).toHaveLength(1)
      expect(actions.listAttempts()[0]).toMatchObject({
        state: 'unknown_outcome',
        failureCode: 'application_identity_unconfirmed',
        verification: 'unavailable'
      })
      expect(actions.listReceipts(BASE_BINDING.principalId)[0]).toMatchObject({
        terminal: 'unknown_outcome',
        verification: 'unavailable'
      })
    })
  })

  it('records unknown outcome rather than retrying when open reports a failure after dispatch', async () => {
    await withHarness(async ({ actions, executor, service, context }) => {
      executor.shouldThrow = true
      const pending = service.handleToolCall(toolCall(), context)
      decide(actions, await waitForApproval(actions), 'approve')

      expect((await pending).success).toBe(false)
      expect(executor.launches).toHaveLength(1)
      expect(actions.listAttempts()[0]).toMatchObject({
        state: 'unknown_outcome',
        failureCode: 'application_launch_failed'
      })
      expect(actions.listReceipts(BASE_BINDING.principalId)[0]?.terminal).toBe('unknown_outcome')
    })
  })
})

describe('fixed macOS command and identity boundaries', () => {
  it('launches with execFile, the exact application path, no shell, and an allowlisted environment', async () => {
    let invocation:
      | {
          executable: string
          arguments_: string[]
          options: ExecFileInvocationOptions
        }
      | undefined
    const runner = new ExecFileCommandRunner({
      environmentSource: {
        HOME: '/Users/tester',
        LANG: 'en_US.UTF-8',
        OPENAI_API_KEY: 'must-not-leak',
        DYLD_INSERT_LIBRARIES: '/tmp/untrusted.dylib'
      },
      invoke(executable, arguments_, options, callback): void {
        invocation = { executable, arguments_, options }
        callback(null, '', '')
      }
    })
    const executor = new DefaultMacApplicationExecutor(runner, 'darwin')

    await executor.launch(MAC_APPLICATION_CATALOG.calculator, new AbortController().signal)

    expect(invocation).toMatchObject({
      executable: '/usr/bin/open',
      arguments_: ['/System/Applications/Calculator.app'],
      options: {
        shell: false,
        windowsHide: true,
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: '/Users/tester',
          LANG: 'en_US.UTF-8'
        }
      }
    })
    expect(invocation?.options.env).not.toHaveProperty('OPENAI_API_KEY')
    expect(invocation?.options.env).not.toHaveProperty('DYLD_INSERT_LIBRARIES')
  })

  it('preflights and post-verifies the exact realpath and bundle identity', async () => {
    const application = MAC_APPLICATION_CATALOG.notes
    const runner = new ScriptedRunner((executable, arguments_) => {
      if (executable === '/usr/bin/mdls') {
        expect(arguments_).toEqual([
          '-raw',
          '-name',
          'kMDItemCFBundleIdentifier',
          application.applicationPath
        ])
        return { stdout: `${application.bundleId}\n`, stderr: '' }
      }
      if (arguments_[0] === 'find') {
        return { stdout: 'ASN:0x0-0x24024-"Notes":\n', stderr: '' }
      }
      return {
        stdout: `"CFBundleIdentifier"="${application.bundleId}"\n"LSBundlePath"="${application.applicationPath}"\n`,
        stderr: ''
      }
    })
    const verifier = new DefaultMacApplicationVerifier(runner, {
      attempts: 1,
      intervalMs: 0,
      platform: 'darwin',
      fileSystem: {
        async realpath(path): Promise<string> {
          return path
        },
        async isDirectory(): Promise<boolean> {
          return true
        }
      }
    })
    const signal = new AbortController().signal

    await expect(verifier.preflight(application, signal)).resolves.toBeUndefined()
    await expect(verifier.verifyRunning(application, signal)).resolves.toBe(true)

    const spoofedVerifier = new DefaultMacApplicationVerifier(runner, {
      attempts: 1,
      platform: 'darwin',
      fileSystem: {
        async realpath(): Promise<string> {
          return '/tmp/spoofed/Notes.app'
        },
        async isDirectory(): Promise<boolean> {
          return true
        }
      }
    })
    await expect(spoofedVerifier.preflight(application, signal)).rejects.toMatchObject({
      code: 'application_realpath_mismatch'
    })
  })

  it('rejects a running process whose reported bundle path is not the fixed catalog path', async () => {
    const application = MAC_APPLICATION_CATALOG.calendar
    const runner = new ScriptedRunner((_executable, arguments_) => {
      if (arguments_[0] === 'find') {
        return { stdout: 'ASN:0x0-0x1234-"Calendar":\n', stderr: '' }
      }
      return {
        stdout: `"CFBundleIdentifier"="${application.bundleId}"\n"LSBundlePath"="/tmp/Calendar.app"\n`,
        stderr: ''
      }
    })
    const verifier = new DefaultMacApplicationVerifier(runner, {
      attempts: 1,
      intervalMs: 0,
      platform: 'darwin',
      fileSystem: {
        async realpath(path): Promise<string> {
          return path
        },
        async isDirectory(): Promise<boolean> {
          return true
        }
      }
    })

    await expect(verifier.verifyRunning(application, new AbortController().signal)).resolves.toBe(
      false
    )
  })
})
