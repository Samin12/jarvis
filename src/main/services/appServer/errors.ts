import type { ClientMethod, JsonRpcErrorShape } from './protocol'

export class AppServerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AppServerError'
  }
}

export class AppServerStateError extends AppServerError {
  constructor(message: string) {
    super(message)
    this.name = 'AppServerStateError'
  }
}

export class AppServerProtocolError extends AppServerError {
  readonly generation: string | null

  constructor(message: string, generation: string | null, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AppServerProtocolError'
    this.generation = generation
  }
}

export class AppServerRequestError extends AppServerError {
  readonly method: ClientMethod
  readonly code: number
  readonly data: JsonRpcErrorShape['data']

  constructor(method: ClientMethod, response: JsonRpcErrorShape) {
    super(`App-server ${method} failed (${response.code}): ${response.message}`)
    this.name = 'AppServerRequestError'
    this.method = method
    this.code = response.code
    this.data = response.data
  }
}

export class AppServerTimeoutError extends AppServerError {
  readonly operation: string
  readonly timeoutMs: number

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs} ms`)
    this.name = 'AppServerTimeoutError'
    this.operation = operation
    this.timeoutMs = timeoutMs
  }
}

export class CodexExecutableError extends AppServerError {
  readonly attemptedPaths: readonly string[]

  constructor(message: string, attemptedPaths: readonly string[] = [], options?: ErrorOptions) {
    super(message, options)
    this.name = 'CodexExecutableError'
    this.attemptedPaths = attemptedPaths
  }
}
