export type DataClassification = 'public' | 'account' | 'sensitive' | 'secret'

export type ActionCapability =
  | 'account.read'
  | 'apps.list'
  | 'conversation.read'
  | 'app.read'
  | 'app.write'
  | 'workspace.read'
  | 'workspace.write'
  | 'workspace.task.dispatch'
  | 'computer.app.open'
  | 'computer.broad'
  | 'credential.access'

export interface ActionIntentInput {
  missionId?: string
  accountId: string
  principalId: string
  capability: ActionCapability
  operation: string
  target: string
  arguments: unknown
  dataClassification: DataClassification
  workspaceRealpath?: string
  workspaceIdentity?: string
  networkRequired: boolean
  providerGeneration: string
  mutating: boolean
}

export interface CanonicalActionIntent extends ActionIntentInput {
  intentId: string
  intentHash: string
  canonicalArguments: string
  createdAt: number
}

export type PolicyDisposition = 'allow_read' | 'require_approval' | 'deny'

export interface PolicyDecision {
  disposition: PolicyDisposition
  policyVersion: string
  reason: string
}

export type ApprovalDecision = 'approve' | 'deny'

export type ApprovalDetail =
  | { kind: 'command'; command: string; cwd: string }
  | { kind: 'task_dispatch'; prompt: string; workspace: string }
  | {
      kind: 'file_change'
      changes: Array<{
        path: string
        changeType: 'add' | 'delete' | 'update'
        diff: string
        movePath: string | null
      }>
    }

export interface ApprovalPreview {
  approvalId: string
  operation: string
  target: string
  capability: ActionCapability
  dataClassification: DataClassification
  reason: string
  detail: ApprovalDetail | null
  expiresAt: number
}

export interface ApprovalRecord extends ApprovalPreview {
  processEpoch: string
  rpcId: string | null
  threadId: string | null
  turnId: string | null
  itemId: string | null
  intentHash: string
  policyVersion: string
  accountId: string
  providerGeneration: string
  workspaceIdentity: string | null
  createdAt: number
  expiresMonotonicMs: number
  consumedAt: number | null
  decision: ApprovalDecision | null
}

export type ActionAttemptState =
  | 'intent'
  | 'approved'
  | 'denied'
  | 'dispatched'
  | 'observed'
  | 'verified'
  | 'blocked'
  | 'unknown_outcome'

export interface ActionAttempt {
  attemptId: string
  intentId: string
  intentHash: string
  accountId: string
  principalId: string | null
  capability: ActionCapability
  operation: string
  target: string
  mutating: boolean
  policyVersion: string
  policyDisposition: PolicyDisposition
  state: ActionAttemptState
  approvalId: string | null
  providerGeneration: string
  providerRequestId: string | null
  providerResourceId: string | null
  verification: 'pending' | 'confirmed' | 'failed' | 'unavailable'
  failureCode: string | null
  createdAt: number
  updatedAt: number
  dispatchedAt: number | null
  observedAt: number | null
  verifiedAt: number | null
}

export interface ActionReceipt {
  receiptId: string
  attemptId: string
  intentHash: string
  approvalId: string | null
  operation: string
  target: string
  terminal: 'success' | 'denied' | 'blocked' | 'unknown_outcome'
  providerRequestId: string | null
  providerResourceId: string | null
  verification: ActionAttempt['verification']
  createdAt: number
  finishedAt: number
  summary: string
}
