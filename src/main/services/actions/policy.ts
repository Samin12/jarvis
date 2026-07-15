import type { CanonicalActionIntent, PolicyDecision } from './contracts'

export const JARVIS_POLICY_VERSION = '2026-07-14.1'

const READ_CAPABILITIES = new Set([
  'account.read',
  'apps.list',
  'conversation.read',
  'app.read',
  'workspace.read'
])

const WRITE_CAPABILITIES = new Set(['app.write', 'workspace.write'])

export class PolicyEngine {
  evaluate(intent: CanonicalActionIntent): PolicyDecision {
    if (intent.dataClassification === 'secret') {
      return this.deny('Secret and credential data cannot be supplied to actions')
    }
    if (intent.capability === 'credential.access') {
      return this.deny('Credential and login-page access is prohibited')
    }
    if (intent.capability === 'computer.broad') {
      return this.deny('Broad computer control is not available in Jarvis 0.2')
    }
    if (intent.capability.startsWith('workspace.') && !intent.workspaceRealpath) {
      return this.deny('A verified workspace scope is required')
    }
    if (intent.capability === 'computer.app.open' && intent.mutating) {
      return {
        disposition: 'require_approval',
        policyVersion: JARVIS_POLICY_VERSION,
        reason: 'Opening this exact macOS application requires one-time approval'
      }
    }
    if (intent.capability === 'workspace.task.dispatch' && intent.mutating) {
      return {
        disposition: 'require_approval',
        policyVersion: JARVIS_POLICY_VERSION,
        reason: 'Delegating this exact prompt into the selected folder requires one-time approval'
      }
    }
    if (READ_CAPABILITIES.has(intent.capability) && !intent.mutating) {
      return {
        disposition: 'allow_read',
        policyVersion: JARVIS_POLICY_VERSION,
        reason: 'Read-only action is allowed inside its account and workspace scope'
      }
    }
    if (WRITE_CAPABILITIES.has(intent.capability) && intent.mutating) {
      return {
        disposition: 'require_approval',
        policyVersion: JARVIS_POLICY_VERSION,
        reason: 'This action changes an external app or selected workspace'
      }
    }
    return this.deny('No host policy rule permits this capability and mutation combination')
  }

  private deny(reason: string): PolicyDecision {
    return { disposition: 'deny', policyVersion: JARVIS_POLICY_VERSION, reason }
  }
}
