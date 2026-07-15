import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ActionAttempt,
  ActionAttemptState,
  ActionReceipt,
  CanonicalActionIntent,
  PolicyDecision
} from './contracts'
import { assembleReceipt, receiptFinishedAt, terminalForAttempt } from './receiptAssembler'

const SCHEMA_VERSION = 2
const MAX_RECEIPT_SUMMARY_BYTES = 32 * 1024

export interface TerminalActionResult {
  attempt: ActionAttempt
  receipt: ActionReceipt
}

export class ActionLedger {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
    this.migrate()
    try {
      chmodSync(path, 0o600)
      chmodSync(dirname(path), 0o700)
    } catch {
      // The database still contains hashes/metadata only; permission failures surface in diagnostics.
    }
  }

  close(): void {
    this.db.close()
  }

  createAttempt(intent: CanonicalActionIntent, policy: PolicyDecision): ActionAttempt {
    const now = Date.now()
    const attempt: ActionAttempt = {
      attemptId: randomUUID(),
      intentId: intent.intentId,
      intentHash: intent.intentHash,
      accountId: intent.accountId,
      principalId: intent.principalId,
      capability: intent.capability,
      operation: intent.operation,
      target: intent.target,
      mutating: intent.mutating,
      policyVersion: policy.policyVersion,
      policyDisposition: policy.disposition,
      state: policy.disposition === 'deny' ? 'denied' : 'intent',
      approvalId: null,
      providerGeneration: intent.providerGeneration,
      providerRequestId: null,
      providerResourceId: null,
      verification: policy.disposition === 'deny' ? 'unavailable' : 'pending',
      failureCode: policy.disposition === 'deny' ? 'policy_denied' : null,
      createdAt: now,
      updatedAt: now,
      dispatchedAt: null,
      observedAt: null,
      verifiedAt: null
    }
    const persistAttempt = (): void => {
      this.db
        .prepare(
          `INSERT INTO action_attempts (
          attempt_id, intent_id, intent_hash, account_id, principal_id, capability, operation, target,
          mutating, policy_version, policy_disposition, state, approval_id,
          provider_generation, provider_request_id, provider_resource_id, verification,
          failure_code, created_at, updated_at, dispatched_at, observed_at, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          attempt.attemptId,
          attempt.intentId,
          attempt.intentHash,
          attempt.accountId,
          attempt.principalId,
          attempt.capability,
          attempt.operation,
          attempt.target,
          attempt.mutating ? 1 : 0,
          attempt.policyVersion,
          attempt.policyDisposition,
          attempt.state,
          null,
          attempt.providerGeneration,
          null,
          null,
          attempt.verification,
          attempt.failureCode,
          now,
          now,
          null,
          null,
          null
        )
    }
    if (attempt.state === 'denied') {
      return this.withImmediateTransaction(() => {
        persistAttempt()
        this.saveReceiptForAttemptWithinTransaction(attempt)
        return attempt
      })
    }
    persistAttempt()
    return attempt
  }

  approve(attemptId: string, approvalId: string): ActionAttempt {
    return this.transition(attemptId, ['intent'], 'approved', { approvalId })
  }

  deny(attemptId: string, approvalId: string | null, failureCode = 'user_denied'): ActionAttempt {
    return this.denyAndSaveReceipt(attemptId, approvalId, failureCode).attempt
  }

  markDispatched(attemptId: string, providerRequestId?: string): ActionAttempt {
    return this.transition(attemptId, ['intent', 'approved'], 'dispatched', {
      providerRequestId: providerRequestId ?? null,
      dispatchedAt: Date.now()
    })
  }

  markObserved(
    attemptId: string,
    observation: { providerRequestId?: string; providerResourceId?: string }
  ): ActionAttempt {
    return this.transition(attemptId, ['dispatched'], 'observed', {
      providerRequestId: observation.providerRequestId,
      providerResourceId: observation.providerResourceId,
      observedAt: Date.now()
    })
  }

  markVerified(attemptId: string): ActionAttempt {
    return this.transition(attemptId, ['observed'], 'verified', {
      verification: 'confirmed',
      verifiedAt: Date.now()
    })
  }

  markVerifiedAndSaveReceipt(attemptId: string, displaySummary?: string): TerminalActionResult {
    return this.transitionAndSaveReceipt(
      attemptId,
      ['observed'],
      'verified',
      {
        verification: 'confirmed',
        verifiedAt: Date.now()
      },
      displaySummary
    )
  }

  markBlocked(attemptId: string, failureCode: string): ActionAttempt {
    return this.withImmediateTransaction(() => {
      const current = this.require(attemptId)
      if (current.mutating && (current.state === 'dispatched' || current.state === 'observed')) {
        return this.transitionWithinTransaction(
          current,
          ['dispatched', 'observed'],
          'unknown_outcome',
          {
            failureCode: 'blocked_after_dispatch',
            verification: 'unavailable'
          }
        )
      }
      return this.transitionWithinTransaction(
        current,
        ['intent', 'approved', 'observed'],
        'blocked',
        {
          failureCode,
          verification: 'failed'
        }
      )
    })
  }

  markBlockedAndSaveReceipt(
    attemptId: string,
    failureCode: string,
    displaySummary?: string
  ): TerminalActionResult {
    return this.withImmediateTransaction(() => {
      const current = this.require(attemptId)
      const attempt =
        current.mutating && (current.state === 'dispatched' || current.state === 'observed')
          ? this.transitionWithinTransaction(
              current,
              ['dispatched', 'observed'],
              'unknown_outcome',
              {
                failureCode: 'blocked_after_dispatch',
                verification: 'unavailable'
              }
            )
          : this.transitionWithinTransaction(
              current,
              ['intent', 'approved', 'observed'],
              'blocked',
              {
                failureCode,
                verification: 'failed'
              }
            )
      return this.saveReceiptForAttemptWithinTransaction(attempt, displaySummary)
    })
  }

  markUnknown(attemptId: string, failureCode = 'outcome_unconfirmed'): ActionAttempt {
    return this.transition(attemptId, ['dispatched', 'observed'], 'unknown_outcome', {
      failureCode,
      verification: 'unavailable'
    })
  }

  markUnknownAndSaveReceipt(
    attemptId: string,
    failureCode = 'outcome_unconfirmed',
    displaySummary?: string
  ): TerminalActionResult {
    return this.transitionAndSaveReceipt(
      attemptId,
      ['dispatched', 'observed'],
      'unknown_outcome',
      {
        failureCode,
        verification: 'unavailable'
      },
      displaySummary
    )
  }

  denyAndSaveReceipt(
    attemptId: string,
    approvalId: string | null,
    failureCode = 'user_denied',
    displaySummary?: string
  ): TerminalActionResult {
    return this.transitionAndSaveReceipt(
      attemptId,
      ['intent', 'approved'],
      'denied',
      {
        approvalId,
        failureCode,
        verification: 'unavailable'
      },
      displaySummary
    )
  }

  recoverInterruptedWrites(providerGeneration?: string): ActionAttempt[] {
    return this.withImmediateTransaction(() => {
      const terminalWithoutReceipts = providerGeneration
        ? this.db
            .prepare(
              `SELECT a.* FROM action_attempts a
               LEFT JOIN action_receipts r ON r.attempt_id = a.attempt_id
               WHERE r.attempt_id IS NULL
                 AND a.state IN ('denied', 'verified', 'blocked', 'unknown_outcome')
                 AND a.provider_generation = ?`
            )
            .all(providerGeneration)
        : this.db
            .prepare(
              `SELECT a.* FROM action_attempts a
               LEFT JOIN action_receipts r ON r.attempt_id = a.attempt_id
               WHERE r.attempt_id IS NULL
                 AND a.state IN ('denied', 'verified', 'blocked', 'unknown_outcome')`
            )
            .all()
      const rows = providerGeneration
        ? this.db
            .prepare(
              `SELECT * FROM action_attempts
               WHERE mutating = 1 AND state IN ('intent', 'approved', 'dispatched', 'observed')
                 AND provider_generation = ?`
            )
            .all(providerGeneration)
        : this.db
            .prepare(
              `SELECT * FROM action_attempts
               WHERE mutating = 1 AND state IN ('intent', 'approved', 'dispatched', 'observed')`
            )
            .all()
      const recovered: ActionAttempt[] = []
      for (const row of terminalWithoutReceipts) {
        const attempt = mapAttempt(row)
        this.saveReceiptForAttemptWithinTransaction(attempt)
        recovered.push(attempt)
      }
      for (const row of rows) {
        const current = mapAttempt(row)
        const beforeDispatch = current.state === 'intent' || current.state === 'approved'
        const attempt = beforeDispatch
          ? this.transitionWithinTransaction(current, [current.state], 'blocked', {
              failureCode:
                current.state === 'intent'
                  ? 'process_interrupted_before_approval'
                  : 'process_interrupted_before_dispatch',
              verification: 'failed'
            })
          : this.transitionWithinTransaction(
              current,
              ['dispatched', 'observed'],
              'unknown_outcome',
              {
                failureCode: 'process_interrupted',
                verification: 'unavailable'
              }
            )
        this.saveReceiptForAttemptWithinTransaction(attempt)
        recovered.push(attempt)
      }
      return recovered
    })
  }

  saveReceipt(receipt: ActionReceipt): void {
    this.withImmediateTransaction(() => {
      const attempt = this.require(receipt.attemptId)
      this.persistReceiptWithinTransaction(receipt, attempt)
    })
  }

  /**
   * Ensure callers that still assemble a terminal receipt after an atomic
   * transition remain idempotent. The candidate is fully validated, but an
   * already-persisted receipt for the same attempt remains authoritative.
   */
  ensureReceipt(receipt: ActionReceipt): void {
    this.withImmediateTransaction(() => {
      const attempt = this.require(receipt.attemptId)
      validateReceipt(receipt, attempt)
      const existing = this.db
        .prepare(
          `SELECT receipt_id, attempt_id FROM action_receipts
           WHERE attempt_id = ? OR receipt_id = ?`
        )
        .get(receipt.attemptId, receipt.receiptId)
      if (existing) {
        if (String(existing.attempt_id) === receipt.attemptId) return
        throw new Error('A conflicting receipt ID already exists')
      }
      this.persistReceiptWithinTransaction(receipt, attempt)
    })
  }

  listReceipts(limit = 200, principalId?: string): ActionReceipt[] {
    const bounded = Math.max(1, Math.min(limit, 1_000))
    const baseQuery = `SELECT r.receipt_id, r.attempt_id, r.terminal, r.summary, r.created_at,
                              r.finished_at, a.intent_hash, a.approval_id, a.operation, a.target,
                              a.provider_request_id, a.provider_resource_id, a.verification
                         FROM action_receipts r
                         JOIN action_attempts a ON a.attempt_id = r.attempt_id`
    const rows = principalId
      ? this.db
          .prepare(`${baseQuery} WHERE a.principal_id = ? ORDER BY r.finished_at DESC LIMIT ?`)
          .all(principalId, bounded)
      : this.db.prepare(`${baseQuery} ORDER BY r.finished_at DESC LIMIT ?`).all(bounded)
    return rows.map((row) => ({
      receiptId: String(row.receipt_id),
      attemptId: String(row.attempt_id),
      intentHash: String(row.intent_hash),
      approvalId: nullableString(row.approval_id),
      operation: String(row.operation),
      target: String(row.target),
      terminal: String(row.terminal) as ActionReceipt['terminal'],
      providerRequestId: nullableString(row.provider_request_id),
      providerResourceId: nullableString(row.provider_resource_id),
      verification: String(row.verification) as ActionReceipt['verification'],
      createdAt: Number(row.created_at),
      finishedAt: Number(row.finished_at),
      summary: String(row.summary)
    }))
  }

  require(attemptId: string): ActionAttempt {
    const row = this.db.prepare('SELECT * FROM action_attempts WHERE attempt_id = ?').get(attemptId)
    if (!row) throw new Error('Action attempt not found')
    return mapAttempt(row)
  }

  list(limit = 200): ActionAttempt[] {
    const bounded = Math.max(1, Math.min(limit, 1_000))
    return this.db
      .prepare('SELECT * FROM action_attempts ORDER BY created_at DESC LIMIT ?')
      .all(bounded)
      .map(mapAttempt)
  }

  private transition(
    attemptId: string,
    allowed: ActionAttemptState[],
    next: ActionAttemptState,
    patch: Partial<ActionAttempt>
  ): ActionAttempt {
    return this.withImmediateTransaction(() => {
      const current = this.require(attemptId)
      return this.transitionWithinTransaction(current, allowed, next, patch)
    })
  }

  private transitionAndSaveReceipt(
    attemptId: string,
    allowed: ActionAttemptState[],
    next: ActionAttemptState,
    patch: Partial<ActionAttempt>,
    displaySummary?: string
  ): TerminalActionResult {
    return this.withImmediateTransaction(() => {
      const current = this.require(attemptId)
      const attempt = this.transitionWithinTransaction(current, allowed, next, patch)
      return this.saveReceiptForAttemptWithinTransaction(attempt, displaySummary)
    })
  }

  private transitionWithinTransaction(
    current: ActionAttempt,
    allowed: ActionAttemptState[],
    next: ActionAttemptState,
    patch: Partial<ActionAttempt>
  ): ActionAttempt {
    if (!allowed.includes(current.state)) {
      throw new Error(`Illegal action transition ${current.state} -> ${next}`)
    }
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined)
    ) as Partial<ActionAttempt>
    const updated: ActionAttempt = {
      ...current,
      ...definedPatch,
      state: next,
      updatedAt: Date.now()
    }
    const result = this.db
      .prepare(
        `UPDATE action_attempts SET
          state = ?, approval_id = ?, provider_request_id = ?, provider_resource_id = ?,
          verification = ?, failure_code = ?, updated_at = ?, dispatched_at = ?,
          observed_at = ?, verified_at = ?
         WHERE attempt_id = ? AND state = ?`
      )
      .run(
        updated.state,
        updated.approvalId,
        updated.providerRequestId,
        updated.providerResourceId,
        updated.verification,
        updated.failureCode,
        updated.updatedAt,
        updated.dispatchedAt,
        updated.observedAt,
        updated.verifiedAt,
        current.attemptId,
        current.state
      )
    if (Number(result.changes) !== 1) {
      throw new Error('Concurrent action transition detected')
    }
    return updated
  }

  private saveReceiptForAttemptWithinTransaction(
    attempt: ActionAttempt,
    displaySummary?: string
  ): TerminalActionResult {
    const receipt = assembleReceipt(attempt, displaySummary)
    this.persistReceiptWithinTransaction(receipt, attempt)
    return { attempt, receipt }
  }

  private persistReceiptWithinTransaction(receipt: ActionReceipt, attempt: ActionAttempt): void {
    validateReceipt(receipt, attempt)
    const existing = this.db
      .prepare(
        `SELECT receipt_id, attempt_id, terminal, summary, created_at, finished_at
           FROM action_receipts
          WHERE attempt_id = ? OR receipt_id = ?`
      )
      .get(receipt.attemptId, receipt.receiptId)
    if (existing) {
      const identical =
        String(existing.receipt_id) === receipt.receiptId &&
        String(existing.attempt_id) === receipt.attemptId &&
        String(existing.terminal) === receipt.terminal &&
        String(existing.summary) === receipt.summary &&
        Number(existing.created_at) === receipt.createdAt &&
        Number(existing.finished_at) === receipt.finishedAt
      if (identical) return
      throw new Error('A conflicting receipt already exists for this attempt or receipt ID')
    }
    const result = this.db
      .prepare(
        `INSERT INTO action_receipts (
          receipt_id, attempt_id, terminal, summary, created_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        receipt.receiptId,
        receipt.attemptId,
        receipt.terminal,
        receipt.summary,
        receipt.createdAt,
        receipt.finishedAt
      )
    if (Number(result.changes) !== 1) {
      throw new Error('Receipt persistence did not insert exactly one row')
    }
  }

  private withImmediateTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jarvis_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_attempts (
        attempt_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        intent_hash TEXT NOT NULL,
        account_id TEXT NOT NULL,
        principal_id TEXT,
        capability TEXT NOT NULL,
        operation TEXT NOT NULL,
        target TEXT NOT NULL,
        mutating INTEGER NOT NULL,
        policy_version TEXT NOT NULL,
        policy_disposition TEXT NOT NULL,
        state TEXT NOT NULL,
        approval_id TEXT,
        provider_generation TEXT NOT NULL,
        provider_request_id TEXT,
        provider_resource_id TEXT,
        verification TEXT NOT NULL,
        failure_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        observed_at INTEGER,
        verified_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_action_attempts_created
        ON action_attempts(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_action_attempts_live_writes
        ON action_attempts(mutating, state);
      CREATE TABLE IF NOT EXISTS action_receipts (
        receipt_id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES action_attempts(attempt_id),
        terminal TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL
      );
    `)
    const columns = this.db.prepare('PRAGMA table_info(action_attempts)').all()
    if (!columns.some((column) => String(column.name) === 'principal_id')) {
      this.db.exec('ALTER TABLE action_attempts ADD COLUMN principal_id TEXT;')
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_action_attempts_principal
        ON action_attempts(principal_id, created_at DESC);
      INSERT INTO jarvis_meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `)
  }

  hasPrincipalHistory(): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 AS present FROM action_attempts WHERE principal_id IS NOT NULL LIMIT 1')
        .get()
    )
  }
}

function mapAttempt(row: Record<string, unknown>): ActionAttempt {
  return {
    attemptId: String(row.attempt_id),
    intentId: String(row.intent_id),
    intentHash: String(row.intent_hash),
    accountId: String(row.account_id),
    principalId: nullableString(row.principal_id),
    capability: String(row.capability) as ActionAttempt['capability'],
    operation: String(row.operation),
    target: String(row.target),
    mutating: Number(row.mutating) === 1,
    policyVersion: String(row.policy_version),
    policyDisposition: String(row.policy_disposition) as ActionAttempt['policyDisposition'],
    state: String(row.state) as ActionAttemptState,
    approvalId: nullableString(row.approval_id),
    providerGeneration: String(row.provider_generation),
    providerRequestId: nullableString(row.provider_request_id),
    providerResourceId: nullableString(row.provider_resource_id),
    verification: String(row.verification) as ActionAttempt['verification'],
    failureCode: nullableString(row.failure_code),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    dispatchedAt: nullableNumber(row.dispatched_at),
    observedAt: nullableNumber(row.observed_at),
    verifiedAt: nullableNumber(row.verified_at)
  }
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function isTerminal(state: ActionAttemptState): boolean {
  return ['denied', 'verified', 'blocked', 'unknown_outcome'].includes(state)
}

function validateReceipt(receipt: ActionReceipt, attempt: ActionAttempt): void {
  if (!isTerminal(attempt.state)) throw new Error('Cannot persist a receipt for a live attempt')
  if (typeof receipt.receiptId !== 'string' || receipt.receiptId.trim().length === 0) {
    throw new Error('Receipt ID is required')
  }
  if (receipt.receiptId.length > 512) throw new Error('Receipt ID exceeds the safety limit')
  if (typeof receipt.summary !== 'string' || receipt.summary.trim().length === 0) {
    throw new Error('Receipt summary is required')
  }
  if (Buffer.byteLength(receipt.summary, 'utf8') > MAX_RECEIPT_SUMMARY_BYTES) {
    throw new Error('Receipt summary exceeds the safety limit')
  }

  const expectedTerminal = terminalForAttempt(attempt)
  const expectedFinishedAt = receiptFinishedAt(attempt)
  const fieldsMatch =
    receipt.attemptId === attempt.attemptId &&
    receipt.intentHash === attempt.intentHash &&
    receipt.approvalId === attempt.approvalId &&
    receipt.operation === attempt.operation &&
    receipt.target === attempt.target &&
    receipt.terminal === expectedTerminal &&
    receipt.providerRequestId === attempt.providerRequestId &&
    receipt.providerResourceId === attempt.providerResourceId &&
    receipt.verification === attempt.verification &&
    receipt.createdAt === attempt.createdAt &&
    receipt.finishedAt === expectedFinishedAt
  if (!fieldsMatch) throw new Error('Receipt does not match its terminal action attempt')
}
