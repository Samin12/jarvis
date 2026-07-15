import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type {
  ApprovalDecision,
  ApprovalPreview,
  ApprovalRecord,
  CanonicalActionIntent,
  PolicyDecision
} from './contracts'

const DEFAULT_TTL_MS = 2 * 60_000
const MAX_TTL_MS = 10 * 60_000

export interface ApprovalContext {
  processEpoch: string
  rpcId?: string
  threadId?: string
  turnId?: string
  itemId?: string
}

export interface ConsumeApprovalContext {
  processEpoch: string
  accountId: string
  providerGeneration: string
  intentHash: string
  workspaceIdentity?: string
}

export class ApprovalBroker {
  private readonly approvals = new Map<string, ApprovalRecord>()

  create(
    intent: CanonicalActionIntent,
    policy: PolicyDecision,
    context: ApprovalContext,
    ttlMs = DEFAULT_TTL_MS
  ): ApprovalPreview {
    if (policy.disposition !== 'require_approval') {
      throw new Error('Only require_approval policy decisions can create approvals')
    }
    const boundedTtl = Math.max(1_000, Math.min(ttlMs, MAX_TTL_MS))
    const now = Date.now()
    const detail = approvalDetail(intent)
    if (
      (intent.capability === 'workspace.write' ||
        intent.capability === 'workspace.task.dispatch') &&
      !detail
    ) {
      throw new Error('Workspace action approval has no complete exact-action preview')
    }
    const record: ApprovalRecord = {
      approvalId: randomUUID(),
      processEpoch: context.processEpoch,
      rpcId: context.rpcId ?? null,
      threadId: context.threadId ?? null,
      turnId: context.turnId ?? null,
      itemId: context.itemId ?? null,
      intentHash: intent.intentHash,
      policyVersion: policy.policyVersion,
      accountId: intent.accountId,
      providerGeneration: intent.providerGeneration,
      workspaceIdentity: intent.workspaceIdentity ?? null,
      operation: intent.operation,
      target: intent.target,
      capability: intent.capability,
      dataClassification: intent.dataClassification,
      reason: policy.reason,
      detail,
      createdAt: now,
      expiresAt: now + boundedTtl,
      expiresMonotonicMs: performance.now() + boundedTtl,
      consumedAt: null,
      decision: null
    }
    this.approvals.set(record.approvalId, record)
    return preview(record)
  }

  consume(
    approvalId: string,
    decision: ApprovalDecision,
    context: ConsumeApprovalContext
  ): ApprovalRecord {
    const record = this.approvals.get(approvalId)
    if (!record) throw new Error('Approval does not exist or was invalidated')
    if (record.consumedAt !== null) throw new Error('Approval has already been used')
    if (performance.now() > record.expiresMonotonicMs) {
      this.approvals.delete(approvalId)
      throw new Error('Approval expired')
    }
    if (record.processEpoch !== context.processEpoch) throw new Error('Approval process changed')
    if (record.accountId !== context.accountId) throw new Error('Approval account changed')
    if (record.providerGeneration !== context.providerGeneration) {
      throw new Error('Approval provider generation changed')
    }
    if (record.intentHash !== context.intentHash) throw new Error('Approval action changed')
    if ((record.workspaceIdentity ?? undefined) !== context.workspaceIdentity) {
      throw new Error('Approval workspace changed')
    }
    record.consumedAt = Date.now()
    record.decision = decision
    return { ...record }
  }

  invalidateAll(): void {
    this.approvals.clear()
  }

  invalidate(approvalId: string): void {
    this.approvals.delete(approvalId)
  }

  invalidateProcess(processEpoch: string): void {
    for (const [id, record] of this.approvals) {
      if (record.processEpoch === processEpoch) this.approvals.delete(id)
    }
  }

  pending(): ApprovalPreview[] {
    const now = performance.now()
    const result: ApprovalPreview[] = []
    for (const [id, record] of this.approvals) {
      if (record.consumedAt !== null || now > record.expiresMonotonicMs) {
        this.approvals.delete(id)
      } else {
        result.push(preview(record))
      }
    }
    return result
  }
}

function preview(record: ApprovalRecord): ApprovalPreview {
  return {
    approvalId: record.approvalId,
    operation: record.operation,
    target: record.target,
    capability: record.capability,
    dataClassification: record.dataClassification,
    reason: record.reason,
    detail: cloneDetail(record.detail),
    expiresAt: record.expiresAt
  }
}

function approvalDetail(intent: CanonicalActionIntent): ApprovalPreview['detail'] {
  const args = parseCanonicalArguments(intent.canonicalArguments)
  if (!args) return null

  if (intent.capability === 'workspace.task.dispatch') {
    if (
      typeof args.prompt !== 'string' ||
      typeof args.workspace !== 'string' ||
      args.prompt.length === 0 ||
      args.prompt.length > 32_000 ||
      args.workspace !== intent.workspaceRealpath ||
      args.workspace !== intent.target
    ) {
      return null
    }
    return { kind: 'task_dispatch', prompt: args.prompt, workspace: args.workspace }
  }

  if (intent.capability !== 'workspace.write') return null

  if (typeof args.command === 'string' && typeof args.cwd === 'string') {
    return { kind: 'command', command: args.command, cwd: args.cwd }
  }

  if (!Array.isArray(args.changes)) return null
  const changes: Extract<ApprovalPreview['detail'], { kind: 'file_change' }>['changes'] = []
  for (const value of args.changes) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const change = value as Record<string, unknown>
    const kind = change.kind
    if (!kind || typeof kind !== 'object' || Array.isArray(kind)) return null
    const changeType = (kind as Record<string, unknown>).type
    const movePath = (kind as Record<string, unknown>).move_path
    if (
      typeof change.path !== 'string' ||
      typeof change.diff !== 'string' ||
      (changeType !== 'add' && changeType !== 'delete' && changeType !== 'update') ||
      (movePath !== undefined && movePath !== null && typeof movePath !== 'string')
    ) {
      return null
    }
    changes.push({
      path: change.path,
      changeType,
      diff: change.diff,
      movePath: typeof movePath === 'string' ? movePath : null
    })
  }
  return changes.length > 0 ? { kind: 'file_change', changes } : null
}

function parseCanonicalArguments(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function cloneDetail(detail: ApprovalPreview['detail']): ApprovalPreview['detail'] {
  if (!detail) return null
  if (detail.kind === 'command') return { ...detail }
  if (detail.kind === 'task_dispatch') return { ...detail }
  return { kind: 'file_change', changes: detail.changes.map((change) => ({ ...change })) }
}
