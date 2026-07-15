import { createHmac, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, type FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { PlanType } from '../appServer'

const SECRET_BYTES = 32
const MAX_ENCRYPTED_SECRET_BYTES = 16 * 1024
const PERSONAL_PLANS = new Set<PlanType>(['free', 'go', 'plus', 'pro', 'prolite'])

export interface PrincipalSecretProtector {
  isAvailable(): boolean
  encrypt(plaintext: string): Buffer
  decrypt(ciphertext: Buffer): string
}

export interface AccountPrincipalStoreOptions {
  path: string
  protector: PrincipalSecretProtector
  hasPrincipalHistory: () => boolean
}

/**
 * Resolves a durable, install-local receipt partition without persisting an
 * email address or reading provider tokens. Workspace plans deliberately
 * return null because pinned Codex does not expose a stable workspace ID.
 */
export class AccountPrincipalStore {
  private secretOperation: Promise<Buffer> | null = null

  constructor(private readonly options: AccountPrincipalStoreOptions) {}

  async resolve(email: string | null, planType: PlanType): Promise<string | null> {
    const identity = email?.trim().toLowerCase() ?? ''
    if (!identity || identity.length > 512 || !PERSONAL_PLANS.has(planType)) return null
    if (!this.options.protector.isAvailable()) {
      if (this.options.hasPrincipalHistory()) {
        throw new Error('Secure account storage is unavailable while durable Jarvis receipts exist')
      }
      return null
    }
    const secret = await this.secret()
    const digest = createHmac('sha256', secret)
      .update('jarvis-chatgpt-principal-v1\0', 'utf8')
      .update(identity, 'utf8')
      .digest('base64url')
    return `acct_v1_${digest}`
  }

  private async secret(): Promise<Buffer> {
    if (!this.secretOperation) {
      this.secretOperation = this.loadOrCreateSecret().catch((error) => {
        this.secretOperation = null
        throw error
      })
    }
    return this.secretOperation
  }

  private async loadOrCreateSecret(): Promise<Buffer> {
    const path = resolve(this.options.path)
    const parent = dirname(path)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const parentInfo = await lstat(parent)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new Error('Jarvis principal storage directory is not private')
    }
    await chmod(parent, 0o700)

    try {
      return await this.readSecret(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (this.options.hasPrincipalHistory()) {
      throw new Error('Jarvis principal key is missing while durable receipt history exists')
    }

    const plaintext = randomBytes(SECRET_BYTES).toString('base64url')
    const ciphertext = this.options.protector.encrypt(plaintext)
    if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_ENCRYPTED_SECRET_BYTES) {
      throw new Error('Jarvis principal key encryption returned an invalid payload')
    }

    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
    let handle: FileHandle | undefined
    try {
      handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        0o600
      )
      await handle.writeFile(ciphertext)
      await handle.chmod(0o600)
      await handle.sync()
      return decodeSecret(plaintext)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return this.readSecret(path)
      throw error
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private async readSecret(path: string): Promise<Buffer> {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
    let handle: FileHandle | undefined
    try {
      handle = await open(path, constants.O_RDONLY | noFollow)
      const metadata = await handle.stat()
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.size <= 0 ||
        metadata.size > MAX_ENCRYPTED_SECRET_BYTES
      ) {
        throw new Error('Jarvis principal key file is invalid')
      }
      const ciphertext = await handle.readFile()
      await handle.chmod(0o600)
      return decodeSecret(this.options.protector.decrypt(ciphertext))
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
}

function decodeSecret(value: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error('Jarvis principal key could not be decrypted')
  }
  const secret = Buffer.from(value, 'base64url')
  if (secret.byteLength !== SECRET_BYTES) throw new Error('Jarvis principal key has invalid length')
  return secret
}
