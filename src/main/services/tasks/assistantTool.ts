import { createHash } from 'node:crypto'

import type { DynamicToolCallResponse } from '../appServer'

export const CODEX_TASK_TOOL_NAMESPACE = 'jarvis_codex'
export const DISPATCH_CODEX_TASK_TOOL_NAME = 'dispatch_task'

export const DISPATCH_CODEX_TASK_DYNAMIC_TOOL = Object.freeze({
  name: DISPATCH_CODEX_TASK_TOOL_NAME,
  description:
    'Dispatch one bounded Codex task into the folder the user selected locally in the Codex panel. The selected folder is host-owned and is never supplied by the model.',
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      prompt: Object.freeze({
        type: 'string',
        minLength: 1,
        maxLength: 32_000,
        description: 'The bounded task for Codex. Do not include or guess a workspace path.'
      })
    }),
    required: Object.freeze(['prompt']),
    additionalProperties: false
  })
})

const TOOL_CALL_KEYS = ['arguments', 'callId', 'namespace', 'threadId', 'tool', 'turnId'] as const
const ARGUMENT_KEYS = ['prompt'] as const

export interface AssistantCodexToolCall {
  readonly namespace: typeof CODEX_TASK_TOOL_NAMESPACE
  readonly tool: typeof DISPATCH_CODEX_TASK_TOOL_NAME
  readonly threadId: string
  readonly turnId: string
  readonly callId: string
  readonly prompt: string
  readonly fingerprint: string
}

export interface AssistantCodexBinding {
  readonly processEpoch: string
  readonly accountId: string
  readonly principalId: string
  readonly providerGeneration: string
  readonly threadId: string
  readonly turnId: string
}

export interface AssistantCodexToolContext {
  readonly rpcId: string
  readonly generation: string
  readonly binding: AssistantCodexBinding | null
  readonly currentBinding: () => AssistantCodexBinding | null
  readonly signal: AbortSignal
}

export function claimsAssistantCodexNamespace(value: unknown): boolean {
  return isPlainObject(value) && value.namespace === CODEX_TASK_TOOL_NAMESPACE
}

export function validateAssistantCodexToolCall(value: unknown): AssistantCodexToolCall {
  const call = requireObject(value, 'Codex dispatch tool call')
  requireExactKeys(call, TOOL_CALL_KEYS, 'Codex dispatch tool call')
  if (call.namespace !== CODEX_TASK_TOOL_NAMESPACE) {
    throw new Error('Codex dispatch tool namespace is invalid')
  }
  if (call.tool !== DISPATCH_CODEX_TASK_TOOL_NAME) {
    throw new Error('Codex dispatch tool name is invalid')
  }
  const threadId = requireIdentifier(call.threadId, 'threadId', 512)
  const turnId = requireIdentifier(call.turnId, 'turnId', 512)
  const callId = requireIdentifier(call.callId, 'callId', 512)
  const args = requireObject(call.arguments, 'Codex dispatch tool arguments')
  requireExactKeys(args, ARGUMENT_KEYS, 'Codex dispatch tool arguments')
  const prompt = requirePrompt(args.prompt)
  return {
    namespace: CODEX_TASK_TOOL_NAMESPACE,
    tool: DISPATCH_CODEX_TASK_TOOL_NAME,
    threadId,
    turnId,
    callId,
    prompt,
    fingerprint: createHash('sha256').update(prompt, 'utf8').digest('hex')
  }
}

export function assistantCodexToolFailure(text: string): DynamicToolCallResponse {
  return { contentItems: [{ type: 'inputText', text }], success: false }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`)
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} contains missing or additional properties`)
  }
}

function requireIdentifier(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    hasControlCharacters(value)
  ) {
    throw new Error(`${label} is not a bounded normalized identifier`)
  }
  return value
}

function requirePrompt(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Codex task prompt must be text')
  const prompt = value.trim()
  if (!prompt || prompt.length > 32_000) {
    throw new Error('Codex task prompt is missing or too long')
  }
  return prompt
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}
