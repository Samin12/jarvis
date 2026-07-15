import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AccountPrincipalStore, type PrincipalSecretProtector } from '../../src/main/services/core'
import {
  ActionLedger,
  canonicalizeIntent,
  type PolicyDecision
} from '../../src/main/services/actions'

const roots: string[] = []

const protector: PrincipalSecretProtector = {
  isAvailable: () => true,
  encrypt: (plaintext) => Buffer.from(`protected:${plaintext}`, 'utf8'),
  decrypt: (ciphertext) => {
    const value = ciphertext.toString('utf8')
    if (!value.startsWith('protected:')) throw new Error('corrupt protected value')
    return value.slice('protected:'.length)
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('AccountPrincipalStore', () => {
  it('is stable across restart, email normalization, and personal plan changes', async () => {
    const { path } = await storePath()
    const first = new AccountPrincipalStore({ path, protector, hasPrincipalHistory: () => false })
    const principal = await first.resolve(' Operator@Example.COM ', 'plus')

    const reopened = new AccountPrincipalStore({
      path,
      protector,
      hasPrincipalHistory: () => true
    })
    expect(await reopened.resolve('operator@example.com', 'pro')).toBe(principal)
    expect(principal).toMatch(/^acct_v1_[A-Za-z0-9_-]{43}$/u)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('isolates different accounts and different Jarvis installations', async () => {
    const firstPath = (await storePath()).path
    const secondPath = (await storePath()).path
    const first = new AccountPrincipalStore({
      path: firstPath,
      protector,
      hasPrincipalHistory: () => false
    })
    const second = new AccountPrincipalStore({
      path: secondPath,
      protector,
      hasPrincipalHistory: () => false
    })

    const accountA = await first.resolve('a@example.com', 'plus')
    expect(await first.resolve('b@example.com', 'plus')).not.toBe(accountA)
    expect(await second.resolve('a@example.com', 'plus')).not.toBe(accountA)
  })

  it('fails closed for missing identity, workspace plans, or unavailable safe storage', async () => {
    const { path } = await storePath()
    const unavailable = new AccountPrincipalStore({
      path,
      protector: { ...protector, isAvailable: () => false },
      hasPrincipalHistory: () => false
    })

    await expect(unavailable.resolve('operator@example.com', 'plus')).resolves.toBeNull()
    await expect(unavailable.resolve(null, 'plus')).resolves.toBeNull()
    await expect(unavailable.resolve('operator@example.com', 'business')).resolves.toBeNull()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never replaces a missing principal key when durable history exists', async () => {
    const { path } = await storePath()
    const store = new AccountPrincipalStore({
      path,
      protector,
      hasPrincipalHistory: () => true
    })
    await expect(store.resolve('operator@example.com', 'plus')).rejects.toThrow(
      'missing while durable receipt history exists'
    )
  })

  it('surfaces unavailable secure storage when durable principal history exists', async () => {
    const { path } = await storePath()
    const store = new AccountPrincipalStore({
      path,
      protector: { ...protector, isAvailable: () => false },
      hasPrincipalHistory: () => true
    })

    await expect(store.resolve('operator@example.com', 'plus')).rejects.toThrow(
      'Secure account storage is unavailable'
    )
  })

  it('rejects corrupt storage and serializes concurrent initialization', async () => {
    const corruptPath = (await storePath()).path
    await mkdir(dirname(corruptPath), { recursive: true })
    await writeFile(corruptPath, 'not encrypted', { mode: 0o600 })
    const corrupt = new AccountPrincipalStore({
      path: corruptPath,
      protector,
      hasPrincipalHistory: () => false
    })
    await expect(corrupt.resolve('operator@example.com', 'plus')).rejects.toThrow(
      'corrupt protected value'
    )

    const concurrentPath = (await storePath()).path
    const concurrent = new AccountPrincipalStore({
      path: concurrentPath,
      protector,
      hasPrincipalHistory: () => false
    })
    const values = await Promise.all(
      Array.from({ length: 8 }, () => concurrent.resolve('operator@example.com', 'plus'))
    )
    expect(new Set(values).size).toBe(1)

    await unlink(concurrentPath)
    await expect(concurrent.resolve('operator@example.com', 'plus')).resolves.toBe(values[0])
  })

  it('restores a recovered unknown-outcome receipt only for the same principal after relaunch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-principal-ledger-'))
    roots.push(root)
    const keyPath = join(root, 'account-principal.key')
    const ledgerPath = join(root, 'actions.sqlite3')
    const firstStore = new AccountPrincipalStore({
      path: keyPath,
      protector,
      hasPrincipalHistory: () => false
    })
    const principal = (await firstStore.resolve('operator@example.com', 'plus'))!
    const policy: PolicyDecision = {
      disposition: 'require_approval',
      policyVersion: 'principal-test-v1',
      reason: 'approval required'
    }
    const firstLedger = new ActionLedger(ledgerPath)
    const attempt = firstLedger.createAttempt(
      canonicalizeIntent({
        accountId: 'session-before-relaunch',
        principalId: principal,
        capability: 'workspace.write',
        operation: 'Write file',
        target: '/workspace/file.txt',
        arguments: {},
        dataClassification: 'account',
        workspaceRealpath: '/workspace',
        workspaceIdentity: 'device:inode',
        networkRequired: false,
        providerGeneration: 'generation-before-relaunch',
        mutating: true
      }),
      policy
    )
    firstLedger.markDispatched(attempt.attemptId, 'provider-request')
    firstLedger.close()

    const reopenedLedger = new ActionLedger(ledgerPath)
    const reopenedStore = new AccountPrincipalStore({
      path: keyPath,
      protector,
      hasPrincipalHistory: () => reopenedLedger.hasPrincipalHistory()
    })
    try {
      const restored = await reopenedStore.resolve('OPERATOR@example.com', 'pro')
      reopenedLedger.recoverInterruptedWrites()
      expect(reopenedLedger.listReceipts(200, restored!)).toMatchObject([
        { attemptId: attempt.attemptId, terminal: 'unknown_outcome' }
      ])
      const different = await reopenedStore.resolve('other@example.com', 'plus')
      expect(reopenedLedger.listReceipts(200, different!)).toEqual([])
    } finally {
      reopenedLedger.close()
    }
  })
})

async function storePath(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-principal-'))
  roots.push(root)
  return { root, path: join(root, 'data', 'principal.key') }
}
