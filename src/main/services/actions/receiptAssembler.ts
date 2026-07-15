import { randomUUID } from 'node:crypto'
import type { ActionAttempt, ActionReceipt } from './contracts'

export function assembleReceipt(attempt: ActionAttempt, displaySummary?: string): ActionReceipt {
  const terminal = terminalForAttempt(attempt)
  const finishedAt = receiptFinishedAt(attempt)
  return {
    receiptId: randomUUID(),
    attemptId: attempt.attemptId,
    intentHash: attempt.intentHash,
    approvalId: attempt.approvalId,
    operation: attempt.operation,
    target: attempt.target,
    terminal,
    providerRequestId: attempt.providerRequestId,
    providerResourceId: attempt.providerResourceId,
    verification: attempt.verification,
    createdAt: attempt.createdAt,
    finishedAt,
    summary: displaySummary?.trim() || defaultSummary(attempt, terminal)
  }
}

export function receiptFinishedAt(attempt: ActionAttempt): number {
  return attempt.state === 'verified'
    ? (attempt.verifiedAt ?? attempt.updatedAt)
    : attempt.updatedAt
}

export function terminalForAttempt(attempt: ActionAttempt): ActionReceipt['terminal'] {
  switch (attempt.state) {
    case 'verified':
      if (attempt.verification !== 'confirmed') {
        throw new Error('A verified attempt must carry confirmed verification')
      }
      return 'success'
    case 'denied':
      if (attempt.verification !== 'unavailable') {
        throw new Error('A denied attempt must carry unavailable verification')
      }
      return 'denied'
    case 'blocked':
      if (attempt.verification !== 'failed') {
        throw new Error('A blocked attempt must carry failed verification')
      }
      return 'blocked'
    case 'unknown_outcome':
      if (attempt.verification !== 'unavailable') {
        throw new Error('An unknown-outcome attempt must carry unavailable verification')
      }
      return 'unknown_outcome'
    default:
      throw new Error(`Attempt ${attempt.attemptId} is not terminal`)
  }
}

function defaultSummary(attempt: ActionAttempt, terminal: ActionReceipt['terminal']): string {
  switch (terminal) {
    case 'success':
      return `${attempt.operation} was verified for ${attempt.target}.`
    case 'denied':
      return `${attempt.operation} was not run.`
    case 'blocked':
      return `${attempt.operation} was blocked before a verified result.`
    case 'unknown_outcome':
      return `${attempt.operation} may have run, but Jarvis could not verify the outcome. Do not retry until the target is checked.`
  }
}
