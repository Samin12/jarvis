import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import type { WorkspaceScope } from '../actions'
import type { WorkspaceWritePlan } from './workspaceTools'

const HELPER_NAME = 'jarvis-workspace-helper'
const HELPER_TIMEOUT_MS = 30_000
const MAX_HELPER_OUTPUT_BYTES = 8 * 1024

export interface NativeWorkspaceWriterOptions {
  isPackaged: boolean
  resourcesPath?: string
  projectRoot?: string
  architecture?: NodeJS.Architecture
  configuration?: 'debug' | 'release'
  executablePath?: string
  appExecutablePath?: string
}

interface VerifiedWorkspaceHelper {
  path: string
  dev: bigint
  ino: bigint
  sha256: string
}

interface PreparedNativeWorkspaceWrite {
  readonly helper: VerifiedWorkspaceHelper
  readonly args: readonly string[]
  readonly input: Buffer
  readonly expectedBytes: number
}

export interface WorkspaceWriter {
  prepare(scope: WorkspaceScope, plan: WorkspaceWritePlan): Promise<unknown>
  execute(prepared: unknown, signal?: AbortSignal): Promise<void>
}

/**
 * Performs the only task-lane mutation in a tiny package-owned native process.
 * The helper binds the selected root and every parent through openat dirfds,
 * then writes only an O_NOFOLLOW-opened exact inode. There is deliberately no
 * pathname-based mutation fallback.
 */
export class NativeWorkspaceWriter implements WorkspaceWriter {
  private readonly preparedWrites = new WeakSet<object>()

  constructor(private readonly options: NativeWorkspaceWriterOptions) {}

  async prepare(
    scope: WorkspaceScope,
    plan: WorkspaceWritePlan
  ): Promise<PreparedNativeWorkspaceWrite> {
    if (process.platform !== 'darwin') {
      throw new Error('Verified workspace writes are available only on macOS')
    }
    const helper = await resolveWorkspaceHelper(this.options)
    const [rootDev, rootIno] = parseWorkspaceIdentity(scope.identity)
    const previous = plan.previous?.bytes ?? Buffer.alloc(0)
    const targetIdentity = plan.previous?.identity
    const args = [
      'write',
      scope.realpath,
      plan.relativePath,
      rootDev.toString(),
      rootIno.toString(),
      plan.parentIdentity.dev.toString(),
      plan.parentIdentity.ino.toString(),
      plan.kind,
      (targetIdentity?.dev ?? 0n).toString(),
      (targetIdentity?.ino ?? 0n).toString(),
      previous.byteLength.toString(),
      plan.expected.byteLength.toString(),
      (plan.mode & 0o777).toString()
    ]
    const prepared: PreparedNativeWorkspaceWrite = Object.freeze({
      helper,
      args: Object.freeze(args),
      input: Buffer.concat([previous, plan.expected]),
      expectedBytes: plan.expected.byteLength
    })
    this.preparedWrites.add(prepared)
    return prepared
  }

  async execute(prepared: unknown, signal?: AbortSignal): Promise<void> {
    if (!isPreparedNativeWorkspaceWrite(prepared) || !this.preparedWrites.delete(prepared)) {
      throw new Error('Workspace write preparation is invalid or has already been consumed')
    }
    if (signal?.aborted) throw new Error('Workspace write was cancelled before dispatch')
    await assertSameHelper(prepared.helper)
    if (signal?.aborted) throw new Error('Workspace write was cancelled before dispatch')
    await runWorkspaceHelper(
      prepared.helper,
      prepared.args,
      prepared.input,
      prepared.expectedBytes,
      signal
    )
    await assertSameHelper(prepared.helper)
  }
}

function isPreparedNativeWorkspaceWrite(value: unknown): value is PreparedNativeWorkspaceWrite {
  return Boolean(value && typeof value === 'object')
}

export async function resolveWorkspaceHelper(
  options: NativeWorkspaceWriterOptions
): Promise<VerifiedWorkspaceHelper> {
  const architecture = resourceArchitecture(options.architecture ?? process.arch)
  const configuration = options.configuration ?? 'release'
  const candidates = options.executablePath
    ? [resolve(options.executablePath)]
    : options.isPackaged
      ? [
          resolve(
            requirePath(options.resourcesPath, 'resourcesPath'),
            'native',
            'macos-speech',
            architecture,
            HELPER_NAME
          )
        ]
      : [
          resolve(
            requirePath(options.projectRoot, 'projectRoot'),
            'native',
            'macos-speech',
            '.build',
            `${architecture}-apple-macosx`,
            configuration,
            HELPER_NAME
          ),
          resolve(
            requirePath(options.projectRoot, 'projectRoot'),
            'native',
            'macos-speech',
            '.build',
            configuration,
            HELPER_NAME
          )
        ]

  const failures: string[] = []
  for (const candidate of candidates) {
    try {
      return await verifyWorkspaceHelper(candidate, architecture, options)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`Verified workspace helper is unavailable: ${failures.join('; ')}`)
}

async function verifyWorkspaceHelper(
  candidate: string,
  architecture: 'arm64' | 'x86_64',
  options: NativeWorkspaceWriterOptions
): Promise<VerifiedWorkspaceHelper> {
  const lexical = resolve(candidate)
  const info = await lstat(lexical, { bigint: true })
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) {
    throw new Error(`${basename(lexical)} must be one physical file`)
  }
  await access(lexical, fsConstants.X_OK)
  const physical = await realpath(lexical)
  if (physical !== lexical) throw new Error(`${basename(lexical)} path is not canonical`)
  const expectedRoot = options.isPackaged
    ? resolve(requirePath(options.resourcesPath, 'resourcesPath'), 'native', 'macos-speech')
    : resolve(requirePath(options.projectRoot, 'projectRoot'), 'native', 'macos-speech')
  assertInside(expectedRoot, physical)

  const lipo = spawnSync('/usr/bin/lipo', ['-archs', physical], {
    encoding: 'utf8',
    timeout: 10_000
  })
  if (lipo.error || lipo.status !== 0)
    throw new Error('workspace helper architecture is unreadable')
  const architectures = lipo.stdout.trim().split(/\s+/u).filter(Boolean)
  if (architectures.length !== 1 || architectures[0] !== architecture) {
    throw new Error(`workspace helper architecture is ${architectures.join(', ') || 'unknown'}`)
  }

  verifyCodeSignature(physical, options)
  return {
    path: physical,
    dev: info.dev,
    ino: info.ino,
    sha256: createHash('sha256')
      .update(await readFile(physical))
      .digest('hex')
  }
}

function verifyCodeSignature(helperPath: string, options: NativeWorkspaceWriterOptions): void {
  const verified = spawnSync('/usr/bin/codesign', ['--verify', '--strict', helperPath], {
    encoding: 'utf8',
    timeout: 10_000
  })
  if (verified.error || verified.status !== 0) {
    throw new Error('workspace helper code signature is invalid')
  }
  if (!options.isPackaged) return

  const appExecutable = resolve(options.appExecutablePath ?? process.execPath)
  const helperSignature = codeSignatureDetails(helperPath)
  const appSignature = codeSignatureDetails(appExecutable)
  const helperTeam = helperSignature.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim()
  const appTeam = appSignature.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim()
  const helperAdHoc = /^Signature=adhoc$/mu.test(helperSignature)
  const appAdHoc = /^Signature=adhoc$/mu.test(appSignature)
  if (helperAdHoc || appAdHoc) {
    if (!helperAdHoc || !appAdHoc)
      throw new Error('workspace helper signing mode differs from Jarvis')
  } else if (!helperTeam || !appTeam || helperTeam !== appTeam) {
    throw new Error('workspace helper signing team differs from Jarvis')
  }
}

function codeSignatureDetails(path: string): string {
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', path], {
    encoding: 'utf8',
    timeout: 10_000
  })
  if (result.error || result.status !== 0) throw new Error('code signature identity is unreadable')
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

async function runWorkspaceHelper(
  helper: VerifiedWorkspaceHelper,
  args: readonly string[],
  input: Buffer,
  expectedBytes: number,
  signal?: AbortSignal
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(helper.path, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { LANG: 'C', PATH: '/usr/bin:/bin' }
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let settled = false
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) rejectPromise(error)
      else resolvePromise()
    }
    const abort = (): void => {
      child.kill('SIGKILL')
      settle(new Error('Workspace write was cancelled after dispatch'))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(new Error('Workspace write helper timed out'))
    }, HELPER_TIMEOUT_MS)
    timer.unref()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    child.once('error', (error) => settle(error))
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.byteLength + chunk.byteLength > MAX_HELPER_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        settle(new Error('Workspace helper output exceeded its safety limit'))
        return
      }
      stdout = Buffer.concat([stdout, chunk])
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.byteLength + chunk.byteLength > MAX_HELPER_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        settle(new Error('Workspace helper output exceeded its safety limit'))
        return
      }
      stderr = Buffer.concat([stderr, chunk])
    })
    child.once('exit', (code, exitSignal) => {
      if (settled) return
      if (code !== 0 || exitSignal) {
        const detail = stderr.toString('utf8').trim().slice(0, 1_000)
        settle(
          new Error(
            `Workspace write helper failed${detail ? `: ${detail}` : ` (${exitSignal ?? code})`}`
          )
        )
        return
      }
      try {
        const response = JSON.parse(stdout.toString('utf8')) as unknown
        if (
          !response ||
          typeof response !== 'object' ||
          Array.isArray(response) ||
          (response as Record<string, unknown>).ok !== true ||
          (response as Record<string, unknown>).bytes !== expectedBytes
        ) {
          throw new Error('Workspace helper returned an invalid response')
        }
        settle()
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)))
      }
    })
    child.stdin.once('error', (error: NodeJS.ErrnoException) => {
      // A helper that rejects a stale identity may close stdin before consuming
      // the bounded preimage. Let its exit status and sanitized diagnostic win.
      if (error.code !== 'EPIPE') settle(error)
    })
    child.stdin.end(input)
  })
}

async function assertSameHelper(expected: VerifiedWorkspaceHelper): Promise<void> {
  const info = await lstat(expected.path, { bigint: true })
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.nlink !== 1n ||
    info.dev !== expected.dev ||
    info.ino !== expected.ino
  ) {
    throw new Error('Workspace helper identity changed during dispatch')
  }
  const hash = createHash('sha256')
    .update(await readFile(expected.path))
    .digest('hex')
  if (hash !== expected.sha256) throw new Error('Workspace helper changed during dispatch')
}

function parseWorkspaceIdentity(identity: string): [bigint, bigint] {
  const match = /^(\d+):(\d+)$/u.exec(identity)
  if (!match) throw new Error('Workspace identity is malformed')
  return [BigInt(match[1]!), BigInt(match[2]!)]
}

function resourceArchitecture(architecture: NodeJS.Architecture): 'arm64' | 'x86_64' {
  if (architecture === 'arm64') return 'arm64'
  if (architecture === 'x64') return 'x86_64'
  throw new Error(`Verified workspace writes do not support ${architecture}`)
}

function requirePath(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required for the workspace helper`)
  return value
}

function assertInside(root: string, candidate: string): void {
  const offset = relative(resolve(root), resolve(candidate))
  if (offset === '' || offset === '..' || offset.startsWith(`..${sep}`)) {
    if (offset !== '') throw new Error('workspace helper resolves outside its package root')
    return
  }
}
