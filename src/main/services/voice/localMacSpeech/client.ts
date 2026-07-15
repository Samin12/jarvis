import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  decodeLocalMacSpeechEvent,
  LOCAL_MAC_SPEECH_MAX_LINE_BYTES,
  LOCAL_MAC_SPEECH_PROTOCOL_VERSION,
  type LocalMacSpeechCommand,
  type LocalMacSpeechEvent,
  type SpeakOptions,
  type StartListeningOptions
} from './protocol'

export interface LocalMacSpeechLaunchOptions {
  executablePath: string
  readyTimeoutMs?: number
}

export type LocalMacSpeechListener = (event: LocalMacSpeechEvent) => void

const MAX_STDERR_BYTES = 4 * 1024

function helperEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
  }
  for (const key of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING']) {
    const value = process.env[key]
    if (value) environment[key] = value
  }
  return environment
}

function syntheticError(code: string, message: string, recoverable: boolean): LocalMacSpeechEvent {
  return {
    type: 'error',
    protocolVersion: LOCAL_MAC_SPEECH_PROTOCOL_VERSION,
    timestampMs: Date.now(),
    data: { code, message, recoverable }
  }
}

async function verifyExecutable(executablePath: string): Promise<string> {
  if (!path.isAbsolute(executablePath)) throw new Error('Speech helper path must be absolute')
  const file = await stat(executablePath)
  if (!file.isFile()) throw new Error('Speech helper path is not a file')
  await access(executablePath, constants.X_OK)
  return executablePath
}

export class LocalMacSpeechClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly listeners = new Set<LocalMacSpeechListener>()
  private stdoutBuffer = Buffer.alloc(0)
  private stderrBuffer = Buffer.alloc(0)
  private expectedExit = false
  private exited = false
  private protocolFailed = false

  private constructor(executablePath: string) {
    this.child = spawn(executablePath, [], {
      cwd: path.dirname(executablePath),
      env: helperEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBuffer = Buffer.concat([this.stderrBuffer, chunk]).subarray(-MAX_STDERR_BYTES)
    })
    this.child.on('error', () => {
      this.emit(
        syntheticError('helper_spawn_failed', 'The local speech helper could not start.', false)
      )
    })
    this.child.on('exit', (code, signal) => {
      this.exited = true
      if (!this.expectedExit && !this.protocolFailed) {
        const detail = this.stderrBuffer.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 512)
        const suffix = detail ? ` ${detail}` : ''
        this.emit(
          syntheticError(
            'helper_exited',
            `The local speech helper exited unexpectedly (${signal ?? code ?? 'unknown'}).${suffix}`,
            true
          )
        )
      }
    })
  }

  static async launch(options: LocalMacSpeechLaunchOptions): Promise<LocalMacSpeechClient> {
    if (process.platform !== 'darwin')
      throw new Error('Local macOS speech is available only on macOS')
    const executablePath = await verifyExecutable(options.executablePath)
    const client = new LocalMacSpeechClient(executablePath)
    await client.waitUntilReady(options.readyTimeoutMs ?? 5_000)
    return client
  }

  subscribe(listener: LocalMacSpeechListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  status(): string {
    return this.send({ id: randomUUID(), type: 'status' })
  }

  requestPermission(): string {
    return this.send({ id: randomUUID(), type: 'permission' })
  }

  startListening(options: StartListeningOptions = {}): string {
    return this.send({ id: randomUUID(), type: 'start', ...options })
  }

  stopListening(): string {
    return this.send({ id: randomUUID(), type: 'stop' })
  }

  cancelListening(): string {
    return this.send({ id: randomUUID(), type: 'cancel' })
  }

  speak(options: SpeakOptions): string {
    return this.send({ id: randomUUID(), type: 'speak', ...options })
  }

  stopSpeaking(): string {
    return this.send({ id: randomUUID(), type: 'stopSpeaking' })
  }

  async close(timeoutMs = 1_000): Promise<void> {
    if (this.exited) return
    this.expectedExit = true
    this.send({ id: randomUUID(), type: 'shutdown' })

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.exited) this.child.kill('SIGTERM')
        resolve()
      }, timeoutMs)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private send(command: LocalMacSpeechCommand): string {
    if (this.exited || this.child.stdin.destroyed)
      throw new Error('Local speech helper is not running')
    const encoded = `${JSON.stringify(command)}\n`
    if (Buffer.byteLength(encoded, 'utf8') > LOCAL_MAC_SPEECH_MAX_LINE_BYTES) {
      throw new Error('Local speech command exceeds the protocol line limit')
    }
    this.child.stdin.write(encoded, 'utf8')
    return command.id
  }

  private waitUntilReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const unsubscribe = this.subscribe((event) => {
        if (event.type === 'ready') {
          clearTimeout(timer)
          unsubscribe()
          resolve()
        } else if (event.type === 'error' && !event.data.recoverable) {
          clearTimeout(timer)
          unsubscribe()
          reject(new Error(event.data.message))
        }
      })
      const timer = setTimeout(() => {
        unsubscribe()
        this.expectedExit = true
        this.child.kill('SIGTERM')
        reject(new Error('Local speech helper did not become ready in time'))
      }, timeoutMs)
    })
  }

  private onStdout(chunk: Buffer): void {
    if (this.protocolFailed) return
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])

    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a)
      if (newline < 0) break
      if (newline > LOCAL_MAC_SPEECH_MAX_LINE_BYTES) {
        this.failProtocol('Local speech helper emitted an oversized event.')
        return
      }
      let line = this.stdoutBuffer.subarray(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1)
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
      if (line.length > 0) this.decodeLine(line)
    }

    if (this.stdoutBuffer.length > LOCAL_MAC_SPEECH_MAX_LINE_BYTES) {
      this.failProtocol('Local speech helper emitted an oversized event.')
    }
  }

  private decodeLine(line: Buffer): void {
    try {
      const parsed: unknown = JSON.parse(line.toString('utf8'))
      this.emit(decodeLocalMacSpeechEvent(parsed))
    } catch {
      this.failProtocol('Local speech helper emitted an invalid event.')
    }
  }

  private failProtocol(message: string): void {
    if (this.protocolFailed) return
    this.protocolFailed = true
    this.expectedExit = true
    this.emit(syntheticError('helper_protocol_error', message, false))
    this.child.kill('SIGTERM')
  }

  private emit(event: LocalMacSpeechEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A consumer must not disrupt helper lifecycle or other subscribers.
      }
    }
  }
}
