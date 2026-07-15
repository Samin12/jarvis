import type {
  ActionAttempt,
  ActionIntentInput,
  ApprovalDecision,
  ApprovalPreview,
  CanonicalActionIntent,
  PolicyDecision
} from './contracts'
import type { ActionReceipt } from './contracts'
import { ActionLedger } from './actionLedger'
import { ApprovalBroker, type ApprovalContext } from './approvalBroker'
import { canonicalizeIntent } from './canonical'
import { PolicyEngine } from './policy'

export interface PreparedAction {
  intent: CanonicalActionIntent
  policy: PolicyDecision
  attempt: ActionAttempt
}

interface PendingDecision {
  prepared: PreparedAction
  resolve: (approved: boolean) => void
  reject: (error: Error) => void
  workspaceIdentity?: string
  timer: NodeJS.Timeout
  signal?: AbortSignal
  abortListener?: () => void
}

export class ActionCoordinator {
  private readonly pending = new Map<string, PendingDecision>()
  private readonly listeners = new Set<(approvals: ApprovalPreview[]) => void>()

  constructor(
    private readonly ledger: ActionLedger,
    private readonly policy = new PolicyEngine(),
    private readonly approvals = new ApprovalBroker()
  ) {}

  prepare(input: ActionIntentInput): PreparedAction {
    const intent = canonicalizeIntent(input)
    const policy = this.policy.evaluate(intent)
    const attempt = this.ledger.createAttempt(intent, policy)
    return { intent, policy, attempt }
  }

  requestApproval(
    prepared: PreparedAction,
    context: ApprovalContext,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (prepared.policy.disposition !== 'require_approval') {
      throw new Error('Action does not require approval')
    }
    const preview = this.approvals.create(prepared.intent, prepared.policy, context)
    const promise = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.cancelPending(preview.approvalId, 'approval_expired', false)
        },
        Math.max(1, preview.expiresAt - Date.now())
      )
      timer.unref()
      const abortListener = signal
        ? (): void => this.cancelPending(preview.approvalId, 'approval_request_cancelled', true)
        : undefined
      this.pending.set(preview.approvalId, {
        prepared,
        resolve,
        reject,
        workspaceIdentity: prepared.intent.workspaceIdentity,
        timer,
        signal,
        abortListener
      })
      if (signal?.aborted) {
        this.cancelPending(preview.approvalId, 'approval_request_cancelled', true)
      } else if (signal && abortListener) {
        signal.addEventListener('abort', abortListener, { once: true })
      }
    })
    this.emit()
    return promise
  }

  markDispatched(prepared: PreparedAction, providerRequestId?: string): ActionAttempt {
    prepared.attempt = this.ledger.markDispatched(prepared.attempt.attemptId, providerRequestId)
    return prepared.attempt
  }

  markObserved(
    prepared: PreparedAction,
    observation: { providerRequestId?: string; providerResourceId?: string }
  ): ActionAttempt {
    prepared.attempt = this.ledger.markObserved(prepared.attempt.attemptId, observation)
    return prepared.attempt
  }

  markVerified(prepared: PreparedAction): ActionAttempt {
    prepared.attempt = this.ledger.markVerified(prepared.attempt.attemptId)
    return prepared.attempt
  }

  markVerifiedAndSaveReceipt(prepared: PreparedAction, displaySummary?: string): ActionReceipt {
    const result = this.ledger.markVerifiedAndSaveReceipt(
      prepared.attempt.attemptId,
      displaySummary
    )
    prepared.attempt = result.attempt
    return result.receipt
  }

  markBlocked(prepared: PreparedAction, failureCode: string): ActionAttempt {
    prepared.attempt = this.ledger.markBlocked(prepared.attempt.attemptId, failureCode)
    return prepared.attempt
  }

  markBlockedAndSaveReceipt(
    prepared: PreparedAction,
    failureCode: string,
    displaySummary?: string
  ): ActionReceipt {
    const result = this.ledger.markBlockedAndSaveReceipt(
      prepared.attempt.attemptId,
      failureCode,
      displaySummary
    )
    prepared.attempt = result.attempt
    return result.receipt
  }

  markUnknown(prepared: PreparedAction, failureCode?: string): ActionAttempt {
    prepared.attempt = this.ledger.markUnknown(prepared.attempt.attemptId, failureCode)
    return prepared.attempt
  }

  markUnknownAndSaveReceipt(
    prepared: PreparedAction,
    failureCode?: string,
    displaySummary?: string
  ): ActionReceipt {
    const result = this.ledger.markUnknownAndSaveReceipt(
      prepared.attempt.attemptId,
      failureCode,
      displaySummary
    )
    prepared.attempt = result.attempt
    return result.receipt
  }

  saveReceipt(receipt: ActionReceipt): void {
    this.ledger.ensureReceipt(receipt)
  }

  listReceipts(principalId: string, limit?: number): ActionReceipt[] {
    return this.ledger.listReceipts(limit, principalId)
  }

  listAttempts(limit?: number): ActionAttempt[] {
    return this.ledger.list(limit)
  }

  recoverInterruptedWrites(providerGeneration?: string): ActionAttempt[] {
    return this.ledger.recoverInterruptedWrites(providerGeneration)
  }

  decide(
    approvalId: string,
    decision: ApprovalDecision,
    current: { processEpoch: string; accountId: string; providerGeneration: string }
  ): void {
    const pending = this.pending.get(approvalId)
    if (!pending) throw new Error('Approval does not exist or has already resolved')
    try {
      const consumed = this.approvals.consume(approvalId, decision, {
        ...current,
        intentHash: pending.prepared.intent.intentHash,
        workspaceIdentity: pending.workspaceIdentity
      })
      if (consumed.decision === 'approve') {
        pending.prepared.attempt = this.ledger.approve(
          pending.prepared.attempt.attemptId,
          approvalId
        )
        pending.resolve(true)
      } else {
        pending.prepared.attempt = this.ledger.deny(pending.prepared.attempt.attemptId, approvalId)
        pending.resolve(false)
      }
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      this.clearPendingResources(pending)
      this.pending.delete(approvalId)
      this.emit()
    }
  }

  invalidateAll(reason = 'approval_context_changed'): void {
    this.approvals.invalidateAll()
    for (const entry of this.pending.values()) {
      this.clearPendingResources(entry)
      try {
        entry.prepared.attempt = this.ledger.deny(entry.prepared.attempt.attemptId, null, reason)
      } catch {
        // A concurrently dispatched attempt is handled by its execution lifecycle.
      }
      entry.reject(new Error('Approval context changed; review the action again'))
    }
    this.pending.clear()
    this.emit()
  }

  cancelApproval(prepared: PreparedAction, reason = 'approval_request_cancelled'): void {
    for (const [approvalId, pending] of this.pending) {
      if (pending.prepared.attempt.attemptId !== prepared.attempt.attemptId) continue
      this.cancelPending(approvalId, reason, true)
    }
  }

  listApprovals(): ApprovalPreview[] {
    return this.approvals.pending()
  }

  onApprovalsChanged(listener: (approvals: ApprovalPreview[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const approvals = this.listApprovals()
    for (const listener of this.listeners) listener(approvals)
  }

  private cancelPending(approvalId: string, reason: string, reject: boolean): void {
    const pending = this.pending.get(approvalId)
    if (!pending) return
    this.clearPendingResources(pending)
    this.approvals.invalidate(approvalId)
    try {
      pending.prepared.attempt = this.ledger.deny(
        pending.prepared.attempt.attemptId,
        approvalId,
        reason
      )
    } catch {
      // A concurrent decision owns the terminal transition.
    }
    this.pending.delete(approvalId)
    if (reject) pending.reject(new Error('Approval request was cancelled'))
    else pending.resolve(false)
    this.emit()
  }

  private clearPendingResources(pending: PendingDecision): void {
    clearTimeout(pending.timer)
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener)
    }
  }
}
