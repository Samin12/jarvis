import { AppServerProtocolError } from './errors'

export const DEFAULT_MAX_PROTOCOL_LINE_BYTES = 1024 * 1024

export interface BoundedJsonLineDecoderOptions {
  maxLineBytes?: number
  generation?: string | null
}

/**
 * Incremental newline-delimited JSON decoder with a byte (not character) cap.
 * A framing error is terminal because continuing could correlate a response to
 * the wrong request.
 */
export class BoundedJsonLineDecoder {
  private readonly maxLineBytes: number
  private readonly generation: string | null
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private chunks: Buffer[] = []
  private lineBytes = 0

  constructor(options: BoundedJsonLineDecoderOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_PROTOCOL_LINE_BYTES
    this.generation = options.generation ?? null
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1) {
      throw new RangeError('maxLineBytes must be a positive safe integer')
    }
  }

  push(chunk: Buffer | Uint8Array | string): unknown[] {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    const values: unknown[] = []
    let offset = 0

    while (offset < buffer.length) {
      const newline = buffer.indexOf(0x0a, offset)
      const end = newline === -1 ? buffer.length : newline
      this.append(buffer.subarray(offset, end))

      if (newline === -1) break
      const value = this.consumeLine()
      if (value !== null) values.push(value)
      offset = newline + 1
    }

    return values
  }

  finish(): unknown[] {
    if (this.lineBytes === 0) return []
    const value = this.consumeLine()
    return value === null ? [] : [value]
  }

  reset(): void {
    this.chunks = []
    this.lineBytes = 0
  }

  private append(chunk: Buffer): void {
    if (chunk.length === 0) return
    const nextLength = this.lineBytes + chunk.length
    if (nextLength > this.maxLineBytes) {
      this.reset()
      throw new AppServerProtocolError(
        `Protocol line exceeded ${this.maxLineBytes} bytes`,
        this.generation
      )
    }
    this.chunks.push(chunk)
    this.lineBytes = nextLength
  }

  private consumeLine(): unknown | null {
    let line = Buffer.concat(this.chunks, this.lineBytes)
    this.chunks = []
    this.lineBytes = 0

    if (line.length > 0 && line[line.length - 1] === 0x0d) {
      line = line.subarray(0, line.length - 1)
    }
    if (line.length === 0) return null

    let text: string
    try {
      text = this.decoder.decode(line)
    } catch (error) {
      throw new AppServerProtocolError('Protocol line is not valid UTF-8', this.generation, {
        cause: error
      })
    }

    try {
      return JSON.parse(text) as unknown
    } catch (error) {
      throw new AppServerProtocolError('Protocol line is not valid JSON', this.generation, {
        cause: error
      })
    }
  }
}

/** Remove common credential shapes before anything reaches a diagnostic sink. */
export function redactAppServerText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(
      /(["']?(?:access_token|refresh_token|id_token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[REDACTED]'
    )
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1?[REDACTED]')
}
