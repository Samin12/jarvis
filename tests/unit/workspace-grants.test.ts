import { mkdir, mkdtemp, rename, rm, symlink, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertAllowedWorkspace,
  WorkspaceGrantRegistry
} from '../../src/main/services/tasks/workspaceGrants'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('workspace grants', () => {
  it('rejects account and credential roots', () => {
    expect(() => assertAllowedWorkspace('/')).toThrow(/project folder/)
    expect(() => assertAllowedWorkspace(homedir())).toThrow(/project folder/)
    expect(() => assertAllowedWorkspace(join(homedir(), '.ssh'))).toThrow(/project folder/)
    expect(() => assertAllowedWorkspace(join(homedir(), 'Library', 'Keychains'))).toThrow(
      /project folder/
    )
  })

  it('rejects an ancestor that contains the account home', () => {
    expect(() => assertAllowedWorkspace(dirname(homedir()))).toThrow(/project folder/)
  })

  it('accepts an ordinary project folder', () => {
    expect(() => assertAllowedWorkspace(join(homedir(), 'Projects', 'jarvis'))).not.toThrow()
  })

  it('honors runtime-specific denied roots', () => {
    const root = join(homedir(), 'Projects', 'private-runtime')
    expect(() => assertAllowedWorkspace(join(root, 'nested'), [root])).toThrow(/project folder/)
  })

  it('rejects a workspace ancestor that contains runtime data', () => {
    const project = join(homedir(), 'Projects', 'jarvis')
    const runtimeData = join(project, '.jarvis-runtime')
    expect(() => assertAllowedWorkspace(project, [runtimeData])).toThrow(/project folder/)
  })

  it('resolves runtime-specific denied roots before checking containment', async () => {
    const root = await temporaryRoot()
    const runtimeData = join(root, 'runtime-data')
    const selected = join(runtimeData, 'nested')
    const runtimeAlias = join(root, 'runtime-data-alias')
    await mkdir(selected, { recursive: true })
    await symlink(runtimeData, runtimeAlias)

    await expect(
      new WorkspaceGrantRegistry([runtimeAlias]).create(selected, 'account-1')
    ).rejects.toThrow(/project folder/)
  })

  it('invalidates a grant when the selected directory is replaced at the same path', async () => {
    const root = await temporaryRoot()
    const selected = join(root, 'workspace')
    await mkdir(selected)
    const registry = new WorkspaceGrantRegistry()
    const grant = await registry.create(selected, 'account-1')

    await rename(selected, join(root, 'original-workspace'))
    await mkdir(selected)

    await expect(registry.resolve(grant.scopeId, 'account-1')).rejects.toThrow(
      /Choose the workspace again/
    )
  })

  it('invalidates a grant when a selected symlink is retargeted into a denied root', async () => {
    const root = await temporaryRoot()
    const selected = join(root, 'selected-workspace')
    const allowedTarget = join(root, 'allowed-workspace')
    const deniedTarget = join(root, 'runtime-data')
    await Promise.all([mkdir(allowedTarget), mkdir(deniedTarget)])
    await symlink(allowedTarget, selected)
    const registry = new WorkspaceGrantRegistry([deniedTarget])
    const grant = await registry.create(selected, 'account-1')

    await unlink(selected)
    await symlink(deniedTarget, selected)

    await expect(registry.resolve(grant.scopeId, 'account-1')).rejects.toThrow(
      /Choose the workspace again/
    )
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(homedir(), '.jarvis-workspace-grants-'))
  temporaryRoots.push(root)
  return root
}
