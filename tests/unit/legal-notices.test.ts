import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildLegalNotices, verifyLegalNotices } from '../../scripts/legal-notices.mjs'

type LegalManifest = {
  schemaVersion: number
  codexEvidence: {
    tag: string
    license: { path: string; sha256: string }
    notice: { path: string; sha256: string }
  }
  componentCount: number
  fileCount: number
  components: Array<{
    name: string
    version: string
    license: string
    repository: { url: string; directory: string | null }
    files: Array<{ path: string; bytes: number; sha256: string }>
  }>
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('bundled third-party legal notices', () => {
  let fixtureRoot: string
  let legalRoot: string

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'jarvis-legal-notices-'))
    legalRoot = join(fixtureRoot, 'legal')
    buildLegalNotices(legalRoot)
  })

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  it('builds and verifies a deterministic manifest for every bundled component', () => {
    const first = verifyLegalNotices(legalRoot)
    const rebuilt = buildLegalNotices(legalRoot)
    const manifest = JSON.parse(
      readFileSync(join(legalRoot, 'manifest.json'), 'utf8')
    ) as LegalManifest

    expect(rebuilt).toEqual(first)
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      componentCount: 11,
      fileCount: 12
    })
    expect(manifest.components.map((component) => component.name)).toEqual([
      'electron',
      'Chromium and bundled third-party components',
      '@openai/codex',
      '@openai/codex-sdk',
      'react',
      'react-dom',
      'scheduler',
      'three',
      '@electron-toolkit/utils',
      '@fontsource/big-shoulders',
      '@fontsource/martian-mono'
    ])
    for (const component of manifest.components) {
      expect(component.version).not.toBe('')
      expect(component.license).not.toBe('')
      expect(component.repository.url).toMatch(/^https:\/\//u)
      for (const file of component.files) {
        expect(file.bytes).toBeGreaterThan(0)
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/u)
      }
    }
  })

  it('pins Codex release evidence and includes Electron Chromium notices', () => {
    const manifest = JSON.parse(
      readFileSync(join(legalRoot, 'manifest.json'), 'utf8')
    ) as LegalManifest
    expect(manifest.codexEvidence).toMatchObject({
      tag: 'rust-v0.144.3',
      license: {
        path: 'components/openai-codex/LICENSE.txt',
        sha256: 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc'
      },
      notice: {
        path: 'components/openai-codex/NOTICE.txt',
        sha256: '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915'
      }
    })
    expect(sha256(join(legalRoot, manifest.codexEvidence.license.path))).toBe(
      manifest.codexEvidence.license.sha256
    )
    expect(sha256(join(legalRoot, manifest.codexEvidence.notice.path))).toBe(
      manifest.codexEvidence.notice.sha256
    )
    expect(
      manifest.components.find(
        (component) => component.name === 'Chromium and bundled third-party components'
      )?.files[0]
    ).toMatchObject({ path: 'components/chromium/LICENSES.chromium.html' })
  })

  it('rejects a tampered legal file', () => {
    writeFileSync(join(legalRoot, 'components/react/LICENSE.txt'), 'tampered\n')
    expect(() => verifyLegalNotices(legalRoot)).toThrow('tampered')
  })

  it('rejects symlinked legal files', () => {
    const path = join(legalRoot, 'components/react/LICENSE.txt')
    unlinkSync(path)
    symlinkSync('../three/LICENSE.txt', path)
    expect(() => verifyLegalNotices(legalRoot)).toThrow('contains a symlink')
  })

  it('rejects missing and extra files', () => {
    const required = join(legalRoot, 'components/react/LICENSE.txt')
    unlinkSync(required)
    expect(() => verifyLegalNotices(legalRoot)).toThrow('is missing')

    buildLegalNotices(legalRoot)
    writeFileSync(join(legalRoot, 'unexpected.txt'), 'unexpected\n')
    expect(() => verifyLegalNotices(legalRoot)).toThrow('contains an extra file')
  })

  it('never replaces an unrelated existing directory', () => {
    const unrelated = join(fixtureRoot, 'unrelated')
    const sentinel = join(unrelated, 'keep-me.txt')
    mkdirSync(unrelated)
    writeFileSync(sentinel, 'not a generated legal tree\n')

    expect(() => buildLegalNotices(unrelated)).toThrow('Refusing to replace an unmanaged directory')
    expect(readFileSync(sentinel, 'utf8')).toBe('not a generated legal tree\n')
  })
})
