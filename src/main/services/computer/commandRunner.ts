import { execFile } from 'node:child_process'

const FIXED_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024
const MAX_ARGUMENT_BYTES = 32 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

const ALLOWED_ENVIRONMENT_KEYS = [
  'HOME',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  '__CF_USER_TEXT_ENCODING'
] as const

export const MAC_FIXED_EXECUTABLES = Object.freeze([
  '/usr/bin/open',
  '/usr/bin/mdls',
  '/usr/bin/lsappinfo'
] as const)

export type MacFixedExecutable = (typeof MAC_FIXED_EXECUTABLES)[number]

export interface FixedCommandResult {
  stdout: string
  stderr: string
}

export interface FixedCommandRunner {
  run(
    executable: MacFixedExecutable,
    arguments_: readonly string[],
    signal?: AbortSignal
  ): Promise<FixedCommandResult>
}

export interface ExecFileInvocationOptions {
  encoding: 'utf8'
  env: NodeJS.ProcessEnv
  maxBuffer: number
  shell: false
  signal?: AbortSignal
  timeout: number
  windowsHide: true
}

export type ExecFileInvoker = (
  executable: string,
  arguments_: string[],
  options: ExecFileInvocationOptions,
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void

export interface ExecFileCommandRunnerOptions {
  environmentSource?: NodeJS.ProcessEnv
  invoke?: ExecFileInvoker
  timeoutMs?: number
}

export class FixedCommandError extends Error {
  constructor(
    message: string,
    readonly executable: MacFixedExecutable
  ) {
    super(message)
    this.name = 'FixedCommandError'
  }
}

export class ExecFileCommandRunner implements FixedCommandRunner {
  private readonly environment: NodeJS.ProcessEnv
  private readonly invoke: ExecFileInvoker
  private readonly timeoutMs: number

  constructor(options: ExecFileCommandRunnerOptions = {}) {
    this.environment = buildAllowlistedEnvironment(options.environmentSource)
    this.invoke = options.invoke ?? invokeExecFile
    this.timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 30_000))
  }

  run(
    executable: MacFixedExecutable,
    arguments_: readonly string[],
    signal?: AbortSignal
  ): Promise<FixedCommandResult> {
    assertFixedCommand(executable, arguments_)
    if (signal?.aborted) return Promise.reject(abortedError())

    return new Promise<FixedCommandResult>((resolve, reject) => {
      this.invoke(
        executable,
        [...arguments_],
        {
          encoding: 'utf8',
          env: { ...this.environment },
          maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
          shell: false,
          signal,
          timeout: this.timeoutMs,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              signal?.aborted
                ? abortedError()
                : new FixedCommandError('A fixed macOS command failed', executable)
            )
            return
          }
          if (
            Buffer.byteLength(stdout, 'utf8') > MAX_COMMAND_OUTPUT_BYTES ||
            Buffer.byteLength(stderr, 'utf8') > MAX_COMMAND_OUTPUT_BYTES
          ) {
            reject(
              new FixedCommandError('A fixed macOS command returned too much data', executable)
            )
            return
          }
          resolve({ stdout, stderr })
        }
      )
    })
  }
}

export function buildAllowlistedEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: FIXED_PATH }
  for (const key of ALLOWED_ENVIRONMENT_KEYS) {
    const value = source[key]
    if (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 4_096 &&
      !value.includes('\0')
    ) {
      environment[key] = value
    }
  }
  return Object.freeze(environment)
}

function assertFixedCommand(executable: MacFixedExecutable, arguments_: readonly string[]): void {
  if (!(MAC_FIXED_EXECUTABLES as readonly string[]).includes(executable)) {
    throw new Error('Executable is outside the fixed macOS command allowlist')
  }
  let totalBytes = 0
  for (const argument of arguments_) {
    if (typeof argument !== 'string' || argument.includes('\0')) {
      throw new Error('Fixed command arguments must be NUL-free strings')
    }
    totalBytes += Buffer.byteLength(argument, 'utf8')
  }
  if (totalBytes > MAX_ARGUMENT_BYTES) {
    throw new Error('Fixed command arguments exceed the safety limit')
  }
}

function invokeExecFile(
  executable: string,
  arguments_: string[],
  options: ExecFileInvocationOptions,
  callback: (error: Error | null, stdout: string, stderr: string) => void
): void {
  execFile(executable, arguments_, options, (error, stdout, stderr) => {
    callback(error, String(stdout), String(stderr))
  })
}

function abortedError(): Error {
  const error = new Error('Computer action was aborted')
  error.name = 'AbortError'
  return error
}
