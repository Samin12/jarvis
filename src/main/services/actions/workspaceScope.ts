import { realpath, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

export interface WorkspaceScope {
  requestedPath: string
  realpath: string
  identity: string
}

export async function createWorkspaceScope(requestedPath: string): Promise<WorkspaceScope> {
  const normalized = resolve(requestedPath)
  const canonical = await realpath(normalized)
  const metadata = await stat(canonical)
  if (!metadata.isDirectory()) throw new Error('Selected workspace is not a directory')
  return {
    requestedPath: normalized,
    realpath: canonical,
    identity: `${metadata.dev}:${metadata.ino}`
  }
}

export async function revalidateWorkspaceScope(scope: WorkspaceScope): Promise<WorkspaceScope> {
  const current = await createWorkspaceScope(scope.requestedPath)
  if (current.realpath !== scope.realpath || current.identity !== scope.identity) {
    throw new Error('Workspace identity changed after approval')
  }
  return current
}

export async function assertPathInsideScope(
  scope: WorkspaceScope,
  targetPath: string
): Promise<string> {
  await revalidateWorkspaceScope(scope)
  const targetRealpath = await realpath(resolve(targetPath))
  const offset = relative(scope.realpath, targetRealpath)
  if (offset === '..' || offset.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Target escapes the approved workspace')
  }
  return targetRealpath
}
