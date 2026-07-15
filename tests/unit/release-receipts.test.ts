import { createHash } from 'node:crypto'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import {
  expectedReleaseReceiptNames,
  prepareReleaseReceipts,
  verifyReleaseReceipts
} from '../../scripts/release-receipts.mjs'

const packageJson = { name: 'jarvis', version: '0.2.0' }
const tag = 'v0.2.0'
const commit = 'a'.repeat(40)
const repository = 'Samin12/jarvis'
const teamId = 'AB12CD34EF'

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

type LegalReceipt = {
  schemaVersion: number
  componentCount: number
  fileCount: number
  codexTag: string
  manifestBytes: number
  manifestSha256: string
}

function createNoticesArchive(path: string): LegalReceipt {
  const source = mkdtempSync(join(tmpdir(), 'jarvis-receipt-legal-'))
  const payloadPath = join(source, 'components', 'demo', 'LICENSE.txt')
  mkdirSync(dirname(payloadPath), { recursive: true })
  const payload = Buffer.from('Example license text.\n')
  writeFileSync(payloadPath, payload)
  const codexTag = 'rust-v0.144.3'
  const manifest = {
    schemaVersion: 1,
    format: 'jarvis-third-party-legal-notices',
    codexEvidence: { tag: codexTag },
    componentCount: 1,
    fileCount: 1,
    components: [
      {
        name: 'demo',
        version: '1.0.0',
        license: 'MIT',
        files: [
          {
            path: 'components/demo/LICENSE.txt',
            bytes: payload.byteLength,
            sha256: sha256(payload)
          }
        ]
      }
    ]
  }
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`
  writeFileSync(join(source, 'manifest.json'), manifestContents, 'utf8')
  const result = spawnSync('zip', ['-X', '-q', '-r', path, '.'], {
    cwd: source,
    encoding: 'utf8'
  })
  if (result.error || result.status !== 0) {
    throw new Error(`zip fixture failed: ${result.stderr || result.error?.message}`)
  }
  return {
    schemaVersion: 1,
    componentCount: 1,
    fileCount: 1,
    codexTag,
    manifestBytes: Buffer.byteLength(manifestContents),
    manifestSha256: sha256(manifestContents)
  }
}

type Fixture = {
  assets: string
  title: string
  body: string
  releaseView: { tagName: string; name: string; body: string }
}

type FailureCapture = { assets?: string }

function createFixture(legalManifestOverride?: string, failureCapture?: FailureCapture): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-release-receipts-'))
  const assets = join(root, 'assets')
  mkdirSync(assets)
  if (failureCapture) failureCapture.assets = assets
  const names = expectedReleaseReceiptNames(packageJson.name, packageJson.version)
  const installers = names.slice(0, 4)
  for (const name of installers) writeFileSync(join(assets, name), `payload:${name}`)
  const legalNotices = createNoticesArchive(join(assets, 'jarvis-0.2.0-third-party-notices.zip'))

  for (const arch of ['arm64', 'x64'] as const) {
    const artifacts = installers
      .filter((name) => name.includes(`-${arch}.`))
      .map((name) => {
        const bytes = readFileSync(join(assets, name))
        return { name, bytes: bytes.byteLength, sha256: sha256(bytes) }
      })
    writeJson(join(assets, `jarvis-0.2.0-${arch}-verification.json`), {
      schemaVersion: 1,
      packageVersion: packageJson.version,
      arch,
      mode: 'release',
      teamId,
      artifacts,
      signedMachOCount: 21,
      signature: 'Developer ID + hardened runtime',
      notarization: 'Gatekeeper accepted + stapled ticket',
      copiedInstall: 'quarantined copies passed Gatekeeper and onboarding smoke',
      nativeHelpers: [
        { name: `${arch}/jarvis-macos-speech`, bytes: 10, sha256: '1'.repeat(64) },
        { name: `${arch}/jarvis-workspace-helper`, bytes: 11, sha256: '2'.repeat(64) }
      ],
      legalNotices: {
        ...legalNotices,
        manifestSha256: legalManifestOverride ?? legalNotices.manifestSha256
      },
      codex: 'codex-cli 0.144.3'
    })
  }

  writeJson(join(assets, 'jarvis-0.2.0-sbom.cdx.json'), {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: 'urn:uuid:12345678-1234-1234-1234-123456789abc',
    metadata: { component: { name: 'jarvis', version: '0.2.0' } },
    components: [
      {
        type: 'library',
        group: '@openai',
        name: 'codex-sdk',
        version: '0.144.3',
        purl: 'pkg:npm/%40openai/codex-sdk@0.144.3',
        licenses: [{ license: { id: 'Apache-2.0' } }]
      },
      {
        type: 'library',
        name: 'react',
        version: '19.2.7',
        purl: 'pkg:npm/react@19.2.7',
        licenses: [{ license: { id: 'MIT' } }]
      }
    ]
  })
  const titlePath = join(root, 'release-title.txt')
  const bodyPath = join(root, 'release-notes.md')
  const summary = prepareReleaseReceipts({
    assetsDir: assets,
    packageJson,
    tag,
    commit,
    repository,
    teamId,
    runUrl: 'https://github.com/Samin12/jarvis/actions/runs/123',
    titleOut: titlePath,
    bodyOut: bodyPath
  })
  expect(summary.assetCount).toBe(11)
  const name = readFileSync(titlePath, 'utf8').trim()
  const body = readFileSync(bodyPath, 'utf8')
  return { assets, title: titlePath, body: bodyPath, releaseView: { tagName: tag, name, body } }
}

function verifyFixture(fixture: Fixture): void {
  verifyReleaseReceipts({
    assetsDir: fixture.assets,
    packageJson,
    tag,
    commit,
    repository,
    releaseView: fixture.releaseView
  })
}

describe('trusted release receipts', () => {
  it('prepares and verifies the exact 11-asset immutable receipt set', () => {
    const fixture = createFixture()
    const summary = verifyReleaseReceipts({
      assetsDir: fixture.assets,
      packageJson,
      tag,
      commit,
      repository,
      releaseView: fixture.releaseView
    })
    expect(summary).toMatchObject({
      schemaVersion: 1,
      assetCount: 11,
      licenseComponentCount: 2,
      legalComponentCount: 1,
      teamId
    })
    expect(
      readFileSync(join(fixture.assets, 'SHA256SUMS'), 'utf8').trim().split('\n')
    ).toHaveLength(10)
    expect(readFileSync(fixture.body, 'utf8')).toContain('CycloneDX SBOM')
  })

  it('rejects changed assets, release metadata, and extra files', () => {
    const changed = createFixture()
    writeFileSync(join(changed.assets, 'jarvis-0.2.0-arm64.dmg'), 'tampered')
    expect(() => verifyFixture(changed)).toThrow('manifest asset evidence changed')

    const metadata = createFixture()
    metadata.releaseView.body += '\nchanged\n'
    expect(() => verifyFixture(metadata)).toThrow('release notes do not match')

    const extra = createFixture()
    writeFileSync(join(extra.assets, 'unexpected.txt'), 'extra')
    expect(() => verifyFixture(extra)).toThrow('must contain exactly')
  })

  it('rejects a notices archive that differs from the legal tree verified in either app', () => {
    const capture: FailureCapture = {}
    expect(() => createFixture('3'.repeat(64), capture)).toThrow(
      'bundled legal-notice evidence does not match the release archive'
    )
    expect(readdirSync(capture.assets!)).toHaveLength(8)
    expect(readdirSync(capture.assets!)).not.toContain('jarvis-0.2.0-licenses.json')
  })

  it('rejects symlinked and hard-linked receipt assets', () => {
    const symlinked = createFixture()
    const checksums = join(symlinked.assets, 'SHA256SUMS')
    const moved = join(dirname(symlinked.assets), 'real-checksums')
    renameSync(checksums, moved)
    symlinkSync(moved, checksums)
    expect(() => verifyFixture(symlinked)).toThrow('must contain only physical files')

    const hardLinked = createFixture()
    const manifest = join(hardLinked.assets, 'jarvis-0.2.0-release-manifest.json')
    const source = join(dirname(hardLinked.assets), 'manifest-hardlink-source')
    linkSync(manifest, source)
    expect(() => verifyFixture(hardLinked)).toThrow('single-link physical file')
    unlinkSync(source)
  })
})
