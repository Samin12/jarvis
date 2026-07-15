import { realpath, stat } from 'node:fs/promises'
import type { MacApplicationDefinition } from './catalog'
import {
  ExecFileCommandRunner,
  type FixedCommandRunner,
  type FixedCommandResult
} from './commandRunner'

const DEFAULT_VERIFICATION_ATTEMPTS = 16
const DEFAULT_VERIFICATION_INTERVAL_MS = 250

export interface MacApplicationExecutor {
  launch(application: MacApplicationDefinition, signal: AbortSignal): Promise<void>
}

export interface MacApplicationVerifier {
  preflight(application: MacApplicationDefinition, signal: AbortSignal): Promise<void>
  verifyRunning(application: MacApplicationDefinition, signal: AbortSignal): Promise<boolean>
}

export interface FileSystemProbe {
  realpath(path: string): Promise<string>
  isDirectory(path: string): Promise<boolean>
}

export type AbortableSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>

export interface MacApplicationVerifierOptions {
  attempts?: number
  fileSystem?: FileSystemProbe
  intervalMs?: number
  platform?: NodeJS.Platform
  sleep?: AbortableSleep
}

export class MacApplicationIdentityError extends Error {
  constructor(readonly code: string) {
    super('The allowlisted macOS application identity could not be verified')
    this.name = 'MacApplicationIdentityError'
  }
}

export class DefaultMacApplicationExecutor implements MacApplicationExecutor {
  constructor(
    private readonly runner: FixedCommandRunner = new ExecFileCommandRunner(),
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async launch(application: MacApplicationDefinition, signal: AbortSignal): Promise<void> {
    assertMacOS(this.platform)
    throwIfAborted(signal)
    await this.runner.run('/usr/bin/open', [application.applicationPath], signal)
    throwIfAborted(signal)
  }
}

export class DefaultMacApplicationVerifier implements MacApplicationVerifier {
  private readonly attempts: number
  private readonly fileSystem: FileSystemProbe
  private readonly intervalMs: number
  private readonly platform: NodeJS.Platform
  private readonly sleep: AbortableSleep

  constructor(
    private readonly runner: FixedCommandRunner = new ExecFileCommandRunner(),
    options: MacApplicationVerifierOptions = {}
  ) {
    this.attempts = Math.max(1, Math.min(options.attempts ?? DEFAULT_VERIFICATION_ATTEMPTS, 40))
    this.fileSystem = options.fileSystem ?? NODE_FILE_SYSTEM_PROBE
    this.intervalMs = Math.max(
      0,
      Math.min(options.intervalMs ?? DEFAULT_VERIFICATION_INTERVAL_MS, 2_000)
    )
    this.platform = options.platform ?? process.platform
    this.sleep = options.sleep ?? sleepWithAbort
  }

  async preflight(application: MacApplicationDefinition, signal: AbortSignal): Promise<void> {
    assertMacOS(this.platform)
    try {
      throwIfAborted(signal)
      const resolvedPath = await this.fileSystem.realpath(application.applicationPath)
      throwIfAborted(signal)
      if (resolvedPath !== application.applicationPath) {
        throw new MacApplicationIdentityError('application_realpath_mismatch')
      }
      if (!(await this.fileSystem.isDirectory(resolvedPath))) {
        throw new MacApplicationIdentityError('application_not_directory')
      }
      throwIfAborted(signal)
      const metadata = await this.runner.run(
        '/usr/bin/mdls',
        ['-raw', '-name', 'kMDItemCFBundleIdentifier', application.applicationPath],
        signal
      )
      throwIfAborted(signal)
      if (parseMetadataScalar(metadata.stdout) !== application.bundleId) {
        throw new MacApplicationIdentityError('application_bundle_identity_mismatch')
      }
    } catch (error) {
      if (error instanceof MacApplicationIdentityError) throw error
      if (signal.aborted || isAbortError(error)) {
        throw new MacApplicationIdentityError('request_aborted')
      }
      throw new MacApplicationIdentityError('application_preflight_failed')
    }
  }

  async verifyRunning(
    application: MacApplicationDefinition,
    signal: AbortSignal
  ): Promise<boolean> {
    assertMacOS(this.platform)
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      throwIfAborted(signal)
      if (await this.verifyOnce(application, signal)) return true
      if (attempt + 1 < this.attempts) await this.sleep(this.intervalMs, signal)
    }
    return false
  }

  private async verifyOnce(
    application: MacApplicationDefinition,
    signal: AbortSignal
  ): Promise<boolean> {
    let found: FixedCommandResult
    try {
      found = await this.runner.run(
        '/usr/bin/lsappinfo',
        ['find', `bundleid=${application.bundleId}`],
        signal
      )
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      return false
    }

    const applicationSerialNumbers = parseApplicationSerialNumbers(found.stdout).slice(0, 16)
    for (const applicationSerialNumber of applicationSerialNumbers) {
      throwIfAborted(signal)
      try {
        const info = await this.runner.run(
          '/usr/bin/lsappinfo',
          ['info', '-only', 'bundleID', '-only', 'bundlePath', applicationSerialNumber],
          signal
        )
        const bundleId = parseLsAppInfoValue(info.stdout, 'CFBundleIdentifier')
        const bundlePath = parseLsAppInfoValue(info.stdout, 'LSBundlePath')
        if (bundleId !== application.bundleId || bundlePath !== application.applicationPath) {
          continue
        }
        const resolvedPath = await this.fileSystem.realpath(bundlePath)
        if (resolvedPath === application.applicationPath) return true
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error
      }
    }
    return false
  }
}

const NODE_FILE_SYSTEM_PROBE: FileSystemProbe = {
  realpath,
  async isDirectory(path: string): Promise<boolean> {
    return (await stat(path)).isDirectory()
  }
}

function parseMetadataScalar(output: string): string | null {
  const value = output.trim()
  if (!value || value === '(null)' || value === '[ NULL ]') return null
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return null
    }
  }
  return value
}

function parseApplicationSerialNumbers(output: string): string[] {
  const matches = output.match(/ASN:0x[0-9a-f]+-0x[0-9a-f]+/gi) ?? []
  return [...new Set(matches)]
}

function parseLsAppInfoValue(output: string, key: string): string | null {
  const prefix = `"${key}"=`
  const line = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(prefix))
  if (!line) return null
  const encoded = line.slice(prefix.length)
  try {
    const value = JSON.parse(encoded) as unknown
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

function assertMacOS(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') {
    throw new MacApplicationIdentityError('unsupported_platform')
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const error = new Error('Computer action was aborted')
  error.name = 'AbortError'
  throw error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer.unref()
  })
}

function abortError(): Error {
  const error = new Error('Computer action was aborted')
  error.name = 'AbortError'
  return error
}
