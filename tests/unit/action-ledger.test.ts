import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  ActionCoordinator,
  ActionLedger,
  assembleReceipt,
  canonicalizeIntent,
  type ActionAttempt,
  type ActionIntentInput,
  type PolicyDecision
} from '../../src/main/services/actions'

const APPROVAL_POLICY: PolicyDecision = {
  disposition: 'require_approval',
  policyVersion: 'ledger-test-v1',
  reason: 'Test writes require approval'
}

const DENY_POLICY: PolicyDecision = {
  disposition: 'deny',
  policyVersion: 'ledger-test-v1',
  reason: 'Host policy denied this action'
}

function writeInput(overrides: Partial<ActionIntentInput> = {}): ActionIntentInput {
  return {
    accountId: 'acct-ledger-test',
    principalId: 'principal-ledger-test',
    capability: 'workspace.write',
    operation: 'file.write',
    target: '/workspace/README.md',
    arguments: { pathHash: 'metadata-only' },
    dataClassification: 'account',
    workspaceRealpath: '/workspace',
    workspaceIdentity: 'device:inode',
    networkRequired: false,
    providerGeneration: 'generation-1',
    mutating: true,
    ...overrides
  }
}

function computerInput(overrides: Partial<ActionIntentInput> = {}): ActionIntentInput {
  return {
    accountId: 'acct-ledger-test',
    principalId: 'principal-ledger-test',
    capability: 'computer.app.open',
    operation: 'Open Calculator',
    target: '/System/Applications/Calculator.app',
    arguments: { appId: 'calculator' },
    dataClassification: 'account',
    networkRequired: false,
    providerGeneration: 'generation-1',
    mutating: true,
    ...overrides
  }
}

function createApprovedWrite(
  ledger: ActionLedger,
  overrides: Partial<ActionIntentInput> = {}
): ActionAttempt {
  const created = ledger.createAttempt(canonicalizeIntent(writeInput(overrides)), APPROVAL_POLICY)
  return ledger.approve(created.attemptId, `approval-${created.attemptId}`)
}

function withLedger(run: (ledger: ActionLedger) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-action-ledger-'))
  const ledger = new ActionLedger(join(directory, 'ledger.sqlite3'))
  try {
    run(ledger)
  } finally {
    ledger.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

async function withAsyncLedger(run: (ledger: ActionLedger) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-action-ledger-'))
  const ledger = new ActionLedger(join(directory, 'ledger.sqlite3'))
  try {
    await run(ledger)
  } finally {
    ledger.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('ActionLedger crash safety', () => {
  it('migrates v1 rows as unclaimed instead of attaching them to a new principal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-action-ledger-v1-'))
    const path = join(directory, 'ledger.sqlite3')
    const raw = new DatabaseSync(path)
    raw.exec(`
      CREATE TABLE jarvis_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE action_attempts (
        attempt_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, intent_hash TEXT NOT NULL,
        account_id TEXT NOT NULL, capability TEXT NOT NULL, operation TEXT NOT NULL,
        target TEXT NOT NULL, mutating INTEGER NOT NULL, policy_version TEXT NOT NULL,
        policy_disposition TEXT NOT NULL, state TEXT NOT NULL, approval_id TEXT,
        provider_generation TEXT NOT NULL, provider_request_id TEXT,
        provider_resource_id TEXT, verification TEXT NOT NULL, failure_code TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, dispatched_at INTEGER,
        observed_at INTEGER, verified_at INTEGER
      );
      CREATE TABLE action_receipts (
        receipt_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES action_attempts(attempt_id),
        terminal TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL
      );
      INSERT INTO jarvis_meta VALUES ('schema_version', '1');
      INSERT INTO action_attempts VALUES (
        'legacy-attempt', 'legacy-intent', 'legacy-hash', 'old-session', 'workspace.write',
        'Legacy write', '/workspace/file', 1, 'v1', 'require_approval', 'denied', NULL,
        'old-generation', NULL, NULL, 'unavailable', 'user_denied', 1, 2, NULL, NULL, NULL
      );
      INSERT INTO action_receipts VALUES (
        'legacy-receipt', 'legacy-attempt', 'denied', 'Legacy receipt', 1, 2
      );
    `)
    raw.close()

    const migrated = new ActionLedger(path)
    try {
      expect(migrated.require('legacy-attempt').principalId).toBeNull()
      expect(migrated.listReceipts()).toHaveLength(1)
      expect(migrated.listReceipts(200, 'new-principal')).toEqual([])
      expect(migrated.hasPrincipalHistory()).toBe(false)
    } finally {
      migrated.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('creates a policy-denied attempt and its receipt in one transaction', () => {
    withLedger((ledger) => {
      const denied = ledger.createAttempt(canonicalizeIntent(writeInput()), DENY_POLICY)

      expect(denied).toMatchObject({
        state: 'denied',
        failureCode: 'policy_denied',
        verification: 'unavailable'
      })
      expect(ledger.listReceipts()).toMatchObject([
        { attemptId: denied.attemptId, terminal: 'denied', verification: 'unavailable' }
      ])
    })
  })

  it('filters durable receipts by a stable principal independently of session bindings', () => {
    withLedger((ledger) => {
      const accountA = ledger.createAttempt(
        canonicalizeIntent(
          writeInput({
            accountId: 'session-a',
            principalId: 'opaque-principal-a',
            target: '/workspace/a'
          })
        ),
        DENY_POLICY
      )
      const accountB = ledger.createAttempt(
        canonicalizeIntent(
          writeInput({
            accountId: 'session-b',
            principalId: 'opaque-principal-b',
            target: '/workspace/b'
          })
        ),
        DENY_POLICY
      )

      expect(ledger.listReceipts(200, 'opaque-principal-a')).toMatchObject([
        { attemptId: accountA.attemptId, target: '/workspace/a' }
      ])
      expect(ledger.listReceipts(200, 'opaque-principal-b')).toMatchObject([
        { attemptId: accountB.attemptId, target: '/workspace/b' }
      ])
      expect(ledger.listReceipts(200, 'unknown-account')).toEqual([])
    })
  })

  it('rolls back an explicit denial when its receipt cannot be persisted', () => {
    withLedger((ledger) => {
      const approved = createApprovedWrite(ledger)

      expect(() =>
        ledger.denyAndSaveReceipt(
          approved.attemptId,
          approved.approvalId,
          'user_denied',
          'x'.repeat(40 * 1024)
        )
      ).toThrow(/summary exceeds/i)

      expect(ledger.require(approved.attemptId).state).toBe('approved')
      expect(ledger.listReceipts()).toEqual([])
    })
  })

  it('backfills a legacy denied attempt whose process died before saving its receipt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jarvis-action-ledger-'))
    const path = join(directory, 'ledger.sqlite3')
    const ledger = new ActionLedger(path)
    const created = ledger.createAttempt(canonicalizeIntent(writeInput()), APPROVAL_POLICY)
    ledger.close()

    const raw = new DatabaseSync(path)
    raw
      .prepare(
        `UPDATE action_attempts
         SET state = 'denied', verification = 'unavailable', failure_code = 'user_denied',
             updated_at = ?
         WHERE attempt_id = ?`
      )
      .run(Date.now(), created.attemptId)
    raw.close()

    const reopened = new ActionLedger(path)
    try {
      expect(reopened.recoverInterruptedWrites()).toMatchObject([
        { attemptId: created.attemptId, state: 'denied' }
      ])
      expect(reopened.listReceipts()).toMatchObject([
        { attemptId: created.attemptId, terminal: 'denied' }
      ])
      expect(reopened.recoverInterruptedWrites()).toEqual([])
    } finally {
      reopened.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('atomically settles every nonterminal mutation phase without retrying any write', () => {
    withLedger((ledger) => {
      const intent = ledger.createAttempt(canonicalizeIntent(writeInput()), APPROVAL_POLICY)

      const approved = createApprovedWrite(ledger, { target: '/workspace/approved.txt' })

      const dispatched = createApprovedWrite(ledger)
      ledger.markDispatched(dispatched.attemptId, 'provider-request-1')

      const observed = createApprovedWrite(ledger, { target: '/workspace/package.json' })
      ledger.markDispatched(observed.attemptId, 'provider-request-2')
      ledger.markObserved(observed.attemptId, {
        providerRequestId: 'provider-request-2',
        providerResourceId: 'provider-item-2'
      })

      const recovered = ledger.recoverInterruptedWrites()
      expect(recovered.map((attempt) => attempt.attemptId).sort()).toEqual(
        [intent.attemptId, approved.attemptId, dispatched.attemptId, observed.attemptId].sort()
      )
      expect(ledger.require(intent.attemptId)).toMatchObject({
        state: 'blocked',
        failureCode: 'process_interrupted_before_approval',
        verification: 'failed'
      })
      expect(ledger.require(approved.attemptId)).toMatchObject({
        state: 'blocked',
        failureCode: 'process_interrupted_before_dispatch',
        verification: 'failed'
      })
      for (const attemptId of [dispatched.attemptId, observed.attemptId]) {
        expect(ledger.require(attemptId)).toMatchObject({
          state: 'unknown_outcome',
          failureCode: 'process_interrupted',
          verification: 'unavailable'
        })
      }

      const receipts = ledger.listReceipts()
      expect(receipts).toHaveLength(4)
      expect(receipts.filter((receipt) => receipt.terminal === 'blocked')).toHaveLength(2)
      expect(receipts.filter((receipt) => receipt.terminal === 'unknown_outcome')).toHaveLength(2)
      expect(receipts.every((receipt) => receipt.verification !== 'pending')).toBe(true)

      const receiptIds = receipts.map((receipt) => receipt.receiptId).sort()
      expect(ledger.recoverInterruptedWrites()).toEqual([])
      expect(
        ledger
          .listReceipts()
          .map((receipt) => receipt.receiptId)
          .sort()
      ).toEqual(receiptIds)
    })
  })

  it('transitions and persists a verified receipt in one transaction', () => {
    withLedger((ledger) => {
      const approved = createApprovedWrite(ledger)
      ledger.markDispatched(approved.attemptId, 'provider-request')
      ledger.markObserved(approved.attemptId, {
        providerRequestId: 'provider-request',
        providerResourceId: 'provider-resource'
      })

      const result = ledger.markVerifiedAndSaveReceipt(approved.attemptId, 'Write verified.')

      expect(result.attempt.state).toBe('verified')
      expect(result.attempt.verification).toBe('confirmed')
      expect(result.receipt.terminal).toBe('success')
      expect(result.receipt.summary).toBe('Write verified.')
      expect(ledger.require(approved.attemptId)).toEqual(result.attempt)
      expect(ledger.listReceipts()).toEqual([result.receipt])
    })
  })

  it('rolls back the terminal transition when receipt validation fails', () => {
    withLedger((ledger) => {
      const approved = createApprovedWrite(ledger)
      ledger.markDispatched(approved.attemptId)
      ledger.markObserved(approved.attemptId, {})

      expect(() =>
        ledger.markVerifiedAndSaveReceipt(approved.attemptId, 'x'.repeat(40 * 1024))
      ).toThrow(/summary exceeds/i)

      expect(ledger.require(approved.attemptId).state).toBe('observed')
      expect(ledger.listReceipts()).toEqual([])
    })
  })

  it('accepts an identical receipt retry and rejects a conflicting retry', () => {
    withLedger((ledger) => {
      const approved = createApprovedWrite(ledger)
      const blocked = ledger.markBlocked(approved.attemptId, 'precondition_failed')
      const receipt = assembleReceipt(blocked, 'No external action was run.')

      ledger.saveReceipt(receipt)
      expect(() => ledger.saveReceipt(receipt)).not.toThrow()
      expect(ledger.listReceipts()).toHaveLength(1)

      expect(() => ledger.saveReceipt({ ...receipt, summary: 'Conflicting summary.' })).toThrow(
        /conflicting receipt/i
      )
      expect(ledger.listReceipts()).toEqual([receipt])
    })
  })

  it('rejects a success receipt unless the attempt is verified', () => {
    withLedger((ledger) => {
      const approved = createApprovedWrite(ledger)
      ledger.deny(approved.attemptId, approved.approvalId)
      const receipt = ledger.listReceipts()[0]!

      expect(() => ledger.saveReceipt({ ...receipt, terminal: 'success' })).toThrow(
        /does not match/i
      )
      expect(ledger.listReceipts()).toEqual([receipt])
    })
  })
})

describe('ActionCoordinator denial receipt boundaries', () => {
  it('atomically receipts a user denial and tolerates the caller ensuring it again', async () => {
    await withAsyncLedger(async (ledger) => {
      const coordinator = new ActionCoordinator(ledger)
      const prepared = coordinator.prepare(computerInput())
      const pending = coordinator.requestApproval(prepared, { processEpoch: 'generation-1' })
      const approval = coordinator.listApprovals()[0]!

      coordinator.decide(approval.approvalId, 'deny', {
        processEpoch: 'generation-1',
        accountId: prepared.intent.accountId,
        providerGeneration: prepared.intent.providerGeneration
      })

      await expect(pending).resolves.toBe(false)
      expect(ledger.require(prepared.attempt.attemptId).state).toBe('denied')
      expect(ledger.listReceipts()).toHaveLength(1)
      expect(() => coordinator.saveReceipt(assembleReceipt(prepared.attempt))).not.toThrow()
      expect(ledger.listReceipts()).toHaveLength(1)
    })
  })

  it('atomically receipts host invalidation before rejecting the approval waiter', async () => {
    await withAsyncLedger(async (ledger) => {
      const coordinator = new ActionCoordinator(ledger)
      const prepared = coordinator.prepare(computerInput())
      const pending = coordinator.requestApproval(prepared, { processEpoch: 'generation-1' })

      coordinator.invalidateAll('account_context_changed')

      await expect(pending).rejects.toThrow(/context changed/i)
      expect(ledger.require(prepared.attempt.attemptId)).toMatchObject({
        state: 'denied',
        failureCode: 'account_context_changed'
      })
      expect(ledger.listReceipts()).toMatchObject([
        { attemptId: prepared.attempt.attemptId, terminal: 'denied' }
      ])
    })
  })

  it('atomically receipts approval expiry before resolving the waiter', async () => {
    vi.useFakeTimers()
    try {
      await withAsyncLedger(async (ledger) => {
        const coordinator = new ActionCoordinator(ledger)
        const prepared = coordinator.prepare(computerInput())
        const pending = coordinator.requestApproval(prepared, { processEpoch: 'generation-1' })

        await vi.advanceTimersByTimeAsync(2 * 60_000 + 1)

        await expect(pending).resolves.toBe(false)
        expect(ledger.require(prepared.attempt.attemptId)).toMatchObject({
          state: 'denied',
          failureCode: 'approval_expired'
        })
        expect(ledger.listReceipts()).toMatchObject([
          { attemptId: prepared.attempt.attemptId, terminal: 'denied' }
        ])
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
