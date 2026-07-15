import { describe, expect, it } from 'vitest'
import { buildMinimalChildEnvironment } from '../../src/main/services/appServer/environment'
import {
  codexExecutableCandidates,
  isVirtualAsarPath
} from '../../src/main/services/appServer/executable'
import {
  BoundedJsonLineDecoder,
  redactAppServerText
} from '../../src/main/services/appServer/jsonLines'
import { parseInboundEnvelope } from '../../src/main/services/appServer/protocol'

describe('bounded app-server framing', () => {
  it('handles chunked CRLF JSON and an unterminated final line', () => {
    const decoder = new BoundedJsonLineDecoder({ maxLineBytes: 64, generation: 'test-generation' })
    expect(decoder.push('{"id":1')).toEqual([])
    expect(decoder.push(',"result":{}}\r\n{"method":"ready"}')).toEqual([{ id: 1, result: {} }])
    expect(decoder.finish()).toEqual([{ method: 'ready' }])
    expect(decoder.finish()).toEqual([])
  })

  it('caps bytes, not characters, and rejects malformed UTF-8 or JSON', () => {
    expect(() => new BoundedJsonLineDecoder({ maxLineBytes: 3 }).push('éé')).toThrow(
      /exceeded 3 bytes/
    )
    expect(() => new BoundedJsonLineDecoder().push(Buffer.from([0xc3, 0x28, 0x0a]))).toThrow(
      /valid UTF-8/
    )
    expect(() => new BoundedJsonLineDecoder().push('{broken}\n')).toThrow(/valid JSON/)
  })

  it('redacts credentials and URL query material before diagnostics', () => {
    const redacted = redactAppServerText(
      'Bearer abc.def_123 access_token=secret-value sk-abcdefghijklmnop https://example.com/path?token=secret'
    )
    expect(redacted).not.toContain('abc.def_123')
    expect(redacted).not.toContain('secret-value')
    expect(redacted).not.toContain('sk-abcdefghijklmnop')
    expect(redacted).not.toContain('token=secret')
    expect(redacted).toContain('[REDACTED]')
  })
})

describe('app-server process boundary', () => {
  it('drops ambient secrets, endpoints, proxies, and attacker-controlled PATH entries', () => {
    const env = buildMinimalChildEnvironment('/tmp/jarvis-isolated-codex', {
      platform: 'darwin',
      source: {
        OPENAI_API_KEY: 'secret',
        OPENAI_BASE_URL: 'https://attacker.example',
        CODEX_HOME: '/private/operator-codex',
        HTTPS_PROXY: 'https://user:password@proxy.example',
        PATH: '/tmp/attacker-bin',
        LANG: 'en_US.UTF-8'
      }
    })

    expect(env.CODEX_HOME).toBe('/tmp/jarvis-isolated-codex')
    expect(env.HOME).toBe('/tmp/jarvis-isolated-codex')
    expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.OPENAI_BASE_URL).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
  })

  it('resolves packaged Codex from one physical app.asar.unpacked location only', () => {
    const [candidate] = codexExecutableCandidates({
      isPackaged: true,
      appRoot: '/Applications/Jarvis.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/Jarvis.app/Contents/Resources',
      platform: 'darwin',
      arch: 'arm64',
      additionalDevelopmentRoots: ['/tmp/attacker']
    })

    expect(candidate).toContain('/app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/')
    expect(candidate).not.toContain('/tmp/attacker')
    expect(isVirtualAsarPath(candidate)).toBe(false)
    expect(
      isVirtualAsarPath('/Applications/Jarvis.app/Contents/Resources/app.asar/bin/codex')
    ).toBe(true)
  })

  it('rejects unknown JSON-RPC envelope identities', () => {
    expect(parseInboundEnvelope({ id: 1, result: {} })).toEqual({ id: 1, result: {} })
    expect(parseInboundEnvelope({ method: 'initialized' })).toEqual({ method: 'initialized' })
    expect(parseInboundEnvelope({ id: 'approval-1', method: 'approval', params: {} })).toEqual({
      id: 'approval-1',
      method: 'approval',
      params: {}
    })
    expect(() => parseInboundEnvelope({ id: {}, result: {} })).toThrow(/Unrecognized/)
  })
})
