import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { createWorkspaceScope, revalidateWorkspaceScope, type WorkspaceScope } from '../actions'

const GRANT_TTL_MS = 8 * 60 * 60_000
const MAX_GRANTS = 32

interface WorkspaceGrant {
  scopeId: string
  scope: Readonly<WorkspaceScope>
  accountId: string
  expiresAt: number
}

/** Main-process-only capabilities minted after a native folder picker choice. */
export class WorkspaceGrantRegistry {
  private readonly grants = new Map<string, WorkspaceGrant>()
  private readonly additionalDeniedRoots: readonly string[]

  constructor(additionalDeniedRoots: readonly string[] = []) {
    this.additionalDeniedRoots = Object.freeze([...additionalDeniedRoots])
  }

  async create(
    selectedPath: string,
    accountId: string
  ): Promise<{ scopeId: string; path: string }> {
    const scope = await createWorkspaceScope(selectedPath)
    await this.assertAllowed(scope.realpath)
    this.prune()
    if (this.grants.size >= MAX_GRANTS) {
      const oldest = this.grants.keys().next().value as string | undefined
      if (oldest) this.grants.delete(oldest)
    }
    const grant: WorkspaceGrant = {
      scopeId: randomUUID(),
      scope: Object.freeze({ ...scope }),
      accountId,
      expiresAt: Date.now() + GRANT_TTL_MS
    }
    this.grants.set(grant.scopeId, grant)
    return { scopeId: grant.scopeId, path: grant.scope.realpath }
  }

  async resolve(scopeId: string, accountId: string): Promise<Readonly<WorkspaceScope>> {
    this.prune()
    const grant = this.grants.get(scopeId)
    if (!grant || grant.accountId !== accountId) throw new Error('Choose the workspace again')
    try {
      const current = await revalidateWorkspaceScope(grant.scope)
      await this.assertAllowed(current.realpath)
      if (
        this.grants.get(scopeId) !== grant ||
        grant.accountId !== accountId ||
        grant.expiresAt <= Date.now()
      ) {
        throw new Error('Workspace grant changed during validation')
      }
      return grant.scope
    } catch {
      this.grants.delete(scopeId)
      throw new Error('Choose the workspace again')
    }
  }

  clear(): void {
    this.grants.clear()
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(id)
    }
  }

  private async assertAllowed(candidate: string): Promise<void> {
    const deniedRoots = await Promise.all(
      this.additionalDeniedRoots.map(async (path) => {
        try {
          return await realpath(resolve(path))
        } catch {
          return resolve(path)
        }
      })
    )
    assertAllowedWorkspace(candidate, deniedRoots)
  }
}

export function assertAllowedWorkspace(
  candidate: string,
  additionalDeniedRoots: readonly string[] = []
): void {
  const home = resolve(homedir())
  const exactDenied = [resolve('/'), home]
  const deniedSubtrees = [
    resolve(home, '.ssh'),
    resolve(home, '.gnupg'),
    resolve(home, '.aws'),
    resolve(home, '.kube'),
    resolve(home, 'Library'),
    '/Applications',
    '/Library',
    '/System',
    '/private',
    '/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/var',
    ...additionalDeniedRoots.map((path) => resolve(path))
  ]
  const physical = resolve(candidate)
  const selectsExactRootOrItsAncestor = exactDenied.some(
    (root) => physical === root || isWithin(physical, root)
  )
  const intersectsDeniedSubtree = deniedSubtrees.some(
    (root) => isWithin(root, physical) || isWithin(physical, root)
  )
  if (selectsExactRootOrItsAncestor || intersectsDeniedSubtree) {
    throw new Error('Choose a project folder, not a system, credential, or account-data folder')
  }
}

function isWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  const offset = relative(resolvedRoot, resolvedCandidate)
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
}
