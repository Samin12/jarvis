import { createHash, randomUUID } from 'node:crypto'
import type { ActionIntentInput, CanonicalActionIntent } from './contracts'

const MAX_CANONICAL_ARGUMENT_BYTES = 256 * 1024

export function stableJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Action arguments must contain finite numbers')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    return `{${entries.join(',')}}`
  }
  throw new Error(`Action arguments cannot contain ${typeof value}`)
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function canonicalizeIntent(input: ActionIntentInput): CanonicalActionIntent {
  const accountId = requireText(input.accountId, 'accountId', 512)
  const principalId = requireText(input.principalId, 'principalId', 512)
  const operation = requireText(input.operation, 'operation', 256)
  const target = requireText(input.target, 'target', 4_096)
  const providerGeneration = requireText(input.providerGeneration, 'providerGeneration', 256)
  const canonicalArguments = stableJson(input.arguments)
  if (Buffer.byteLength(canonicalArguments, 'utf8') > MAX_CANONICAL_ARGUMENT_BYTES) {
    throw new Error('Action arguments exceed the 256 KiB safety limit')
  }

  const normalized: ActionIntentInput = {
    ...input,
    accountId,
    principalId,
    operation,
    target,
    providerGeneration,
    missionId: input.missionId?.trim() || undefined,
    workspaceRealpath: input.workspaceRealpath?.trim() || undefined,
    workspaceIdentity: input.workspaceIdentity?.trim() || undefined
  }
  const digestPayload = stableJson({
    accountId: normalized.accountId,
    principalId: normalized.principalId,
    capability: normalized.capability,
    operation: normalized.operation,
    target: normalized.target,
    arguments: JSON.parse(canonicalArguments) as unknown,
    dataClassification: normalized.dataClassification,
    workspaceRealpath: normalized.workspaceRealpath ?? null,
    workspaceIdentity: normalized.workspaceIdentity ?? null,
    networkRequired: normalized.networkRequired,
    providerGeneration: normalized.providerGeneration,
    mutating: normalized.mutating
  })

  return {
    ...normalized,
    intentId: randomUUID(),
    intentHash: sha256(digestPayload),
    canonicalArguments,
    createdAt: Date.now()
  }
}

function requireText(value: string, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required`)
  }
  const normalized = value.trim()
  if (normalized.length > max) throw new Error(`${name} exceeds ${max} characters`)
  return normalized
}
