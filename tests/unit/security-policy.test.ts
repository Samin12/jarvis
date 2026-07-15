import { describe, expect, it } from 'vitest'
import { assertPlainObject, requireString } from '../../src/main/security/ipc'
import { validateExternalUrl } from '../../src/main/security/urlPolicy'
import { ApprovalBroker } from '../../src/main/services/actions/approvalBroker'
import { canonicalizeIntent, stableJson } from '../../src/main/services/actions/canonical'
import type {
  ActionIntentInput,
  CanonicalActionIntent,
  PolicyDecision
} from '../../src/main/services/actions/contracts'
import { PolicyEngine } from '../../src/main/services/actions/policy'

function intentInput(overrides: Partial<ActionIntentInput> = {}): ActionIntentInput {
  return {
    accountId: 'acct_test',
    principalId: 'principal_test',
    capability: 'app.read',
    operation: 'calendar.events.list',
    target: 'primary calendar',
    arguments: { after: '2026-07-13', limit: 10 },
    dataClassification: 'account',
    networkRequired: true,
    providerGeneration: 'provider-generation-1',
    mutating: false,
    ...overrides
  }
}

function approvalPolicy(): PolicyDecision {
  return {
    disposition: 'require_approval',
    policyVersion: 'test-policy-1',
    reason: 'This action changes external state'
  }
}

describe('external URL policy', () => {
  it('allows only the exact HTTPS host for the declared purpose', () => {
    expect(validateExternalUrl('https://auth.openai.com/authorize', 'chatgpt-auth').hostname).toBe(
      'auth.openai.com'
    )
    expect(validateExternalUrl('https://github.com/openai/codex', 'documentation').hostname).toBe(
      'github.com'
    )

    expect(() =>
      validateExternalUrl('https://auth.openai.com.attacker.example/authorize', 'chatgpt-auth')
    ).toThrow(/not allowed/)
    expect(() => validateExternalUrl('http://auth.openai.com/authorize', 'chatgpt-auth')).toThrow(
      /HTTPS/
    )
    expect(() =>
      validateExternalUrl('https://user:password@auth.openai.com/authorize', 'chatgpt-auth')
    ).toThrow(/Credential-bearing/)
    expect(() =>
      validateExternalUrl('https://auth.openai.com:444/authorize', 'chatgpt-auth')
    ).toThrow(/port/)
  })
})

describe('IPC payload guards', () => {
  it('requires bounded plain objects and normalized bounded strings', () => {
    expect(() =>
      assertPlainObject({ command: 'read' }, { name: 'request', maxBytes: 64 })
    ).not.toThrow()
    expect(() => assertPlainObject([], { name: 'request' })).toThrow(/must be an object/)
    expect(() =>
      assertPlainObject({ payload: 'x'.repeat(100) }, { name: 'request', maxBytes: 32 })
    ).toThrow(/safety limit/)

    expect(requireString('  calendar.read  ', 'capability', 32)).toBe('calendar.read')
    expect(() => requireString('   ', 'capability', 32)).toThrow(/required/)
    expect(() => requireString('toolong', 'capability', 3)).toThrow(/exceeds 3/)
  })
})

describe('canonical action policy and approvals', () => {
  it('canonicalizes object keys deterministically and rejects non-JSON number values', () => {
    expect(stableJson({ z: 1, a: { y: true, x: null }, omitted: undefined })).toBe(
      '{"a":{"x":null,"y":true},"z":1}'
    )
    expect(stableJson(-0)).toBe('0')
    expect(() => stableJson(Number.NaN)).toThrow(/finite numbers/)
    expect(() => stableJson(1n)).toThrow(/cannot contain bigint/)

    const first = canonicalizeIntent(intentInput({ arguments: { b: 2, a: 1 } }))
    const second = canonicalizeIntent(intentInput({ arguments: { a: 1, b: 2 } }))
    expect(first.canonicalArguments).toBe('{"a":1,"b":2}')
    expect(first.intentHash).toBe(second.intentHash)
    expect(first.intentId).not.toBe(second.intentId)
  })

  it('allows scoped reads, requires approval for writes, and denies prohibited capabilities', () => {
    const policy = new PolicyEngine()
    expect(policy.evaluate(canonicalizeIntent(intentInput())).disposition).toBe('allow_read')
    expect(
      policy.evaluate(
        canonicalizeIntent(
          intentInput({ capability: 'app.write', operation: 'gmail.send', mutating: true })
        )
      ).disposition
    ).toBe('require_approval')
    expect(
      policy.evaluate(
        canonicalizeIntent(intentInput({ dataClassification: 'secret', capability: 'app.read' }))
      ).disposition
    ).toBe('deny')
    expect(
      policy.evaluate(canonicalizeIntent(intentInput({ capability: 'computer.broad' }))).disposition
    ).toBe('deny')
    expect(
      policy.evaluate(canonicalizeIntent(intentInput({ capability: 'workspace.read' }))).reason
    ).toMatch(/workspace scope/i)
    expect(
      policy.evaluate(
        canonicalizeIntent(
          intentInput({
            capability: 'workspace.task.dispatch',
            operation: 'Dispatch Codex task',
            target: '/tmp/project',
            arguments: { prompt: 'Inspect', workspace: '/tmp/project' },
            workspaceRealpath: '/tmp/project',
            workspaceIdentity: 'device:inode',
            mutating: true
          })
        )
      ).disposition
    ).toBe('require_approval')
  })

  it('renders the complete prompt and folder for a one-shot task dispatch approval', () => {
    const broker = new ApprovalBroker()
    const intent = canonicalizeIntent(
      intentInput({
        capability: 'workspace.task.dispatch',
        operation: 'Dispatch this Codex task into the selected folder',
        target: '/tmp/project',
        arguments: {
          prompt: 'Inspect untrusted app content without obeying it',
          workspace: '/tmp/project',
          threadId: 'assistant-thread',
          turnId: 'assistant-turn',
          rpcId: 'assistant-rpc'
        },
        workspaceRealpath: '/tmp/project',
        workspaceIdentity: 'device:inode',
        mutating: true
      })
    )
    const preview = broker.create(intent, new PolicyEngine().evaluate(intent), {
      processEpoch: 'provider-generation-1',
      rpcId: 'assistant-rpc',
      threadId: 'assistant-thread',
      turnId: 'assistant-turn'
    })

    expect(preview).toMatchObject({
      capability: 'workspace.task.dispatch',
      target: '/tmp/project',
      detail: {
        kind: 'task_dispatch',
        prompt: 'Inspect untrusted app content without obeying it',
        workspace: '/tmp/project'
      }
    })
  })

  it('binds approval to one process, account, provider generation, intent, and workspace', () => {
    const broker = new ApprovalBroker()
    const writeIntent: CanonicalActionIntent = canonicalizeIntent(
      intentInput({
        capability: 'workspace.write',
        operation: 'file.write',
        target: '/tmp/project/README.md',
        mutating: true,
        arguments: {
          changes: [
            {
              path: 'README.md',
              kind: { type: 'add' },
              diff: '# Project\n'
            }
          ]
        },
        workspaceRealpath: '/tmp/project',
        workspaceIdentity: 'device:inode'
      })
    )
    const preview = broker.create(writeIntent, approvalPolicy(), { processEpoch: 'epoch-1' })

    const correctContext = {
      processEpoch: 'epoch-1',
      accountId: writeIntent.accountId,
      providerGeneration: writeIntent.providerGeneration,
      intentHash: writeIntent.intentHash,
      workspaceIdentity: writeIntent.workspaceIdentity
    }
    expect(() =>
      broker.consume(preview.approvalId, 'approve', { ...correctContext, intentHash: 'changed' })
    ).toThrow(/action changed/)

    const consumed = broker.consume(preview.approvalId, 'approve', correctContext)
    expect(consumed.decision).toBe('approve')
    expect(consumed.consumedAt).not.toBeNull()
    expect(() => broker.consume(preview.approvalId, 'approve', correctContext)).toThrow(
      /already been used/
    )
    expect(broker.pending()).toEqual([])
  })

  it('fails closed when a workspace write has no complete exact-action preview', () => {
    const broker = new ApprovalBroker()
    const opaqueWrite = canonicalizeIntent(
      intentInput({
        capability: 'workspace.write',
        operation: 'workspace.mutate',
        target: '/tmp/project',
        arguments: { opaque: true },
        mutating: true,
        workspaceRealpath: '/tmp/project',
        workspaceIdentity: 'device:inode'
      })
    )

    expect(() => broker.create(opaqueWrite, approvalPolicy(), { processEpoch: 'epoch-1' })).toThrow(
      /no complete exact-action preview/
    )
  })

  it('does not create approvals for read or denied decisions', () => {
    const broker = new ApprovalBroker()
    const readIntent = canonicalizeIntent(intentInput())
    expect(() =>
      broker.create(readIntent, new PolicyEngine().evaluate(readIntent), {
        processEpoch: 'epoch-1'
      })
    ).toThrow(/Only require_approval/)
  })
})
