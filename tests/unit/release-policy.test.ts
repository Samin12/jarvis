import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertDeveloperIdSignature,
  assertReleaseMatchesContract,
  createReleaseContract,
  renderTrustedReleaseNotes,
  requireAppleApiIssuer,
  requireAppleApiKeyId,
  requireAppleTeamId,
  verifyLocalReleaseAssets,
  type ReleaseContract
} from '../../scripts/release-policy.mjs'

const teamId = 'AB12CD34EF'
const version = '0.2.0'
const tag = `v${version}`
const commit = 'a'.repeat(40)

type FixtureAsset = {
  name: string
  size: number
  digest: string
  bytes: Buffer
}

type PackageEvidence = {
  schemaVersion: number
  packageVersion: string
  arch: 'arm64' | 'x64'
  mode: string
  teamId: string
  signature: string
  notarization: string
  copiedInstall: string
  artifacts: Array<{ name: string; bytes: number; sha256: string }>
}

function releaseAssets(): FixtureAsset[] {
  return ['arm64', 'x64'].flatMap((arch) =>
    ['dmg', 'zip'].map((extension) => {
      const bytes = Buffer.from(`${arch}-${extension}`)
      return {
        name: `jarvis-${version}-${arch}.${extension}`,
        size: bytes.byteLength,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        bytes
      }
    })
  )
}

function contractFixture(): ReleaseContract {
  const assets = releaseAssets()
  return createReleaseContract({
    tag,
    commit,
    repository: 'Samin12/jarvis',
    packageJson: { name: 'jarvis', version },
    releaseView: {
      tagName: tag,
      isDraft: true,
      isPrerelease: false,
      assets: assets.map((asset) => ({
        name: asset.name,
        size: asset.size,
        digest: asset.digest
      }))
    }
  })
}

function packageEvidence(contract: ReleaseContract, arch: 'arm64' | 'x64'): PackageEvidence {
  return {
    schemaVersion: 1,
    packageVersion: contract.version,
    arch,
    mode: 'release',
    teamId,
    signature: 'Developer ID + hardened runtime',
    notarization: 'Gatekeeper accepted + stapled ticket',
    copiedInstall: 'quarantined copies passed Gatekeeper and onboarding smoke',
    artifacts: contract.assets
      .filter((asset) => asset.name.includes(`-${arch}.`))
      .map((asset) => ({
        name: asset.name,
        bytes: asset.size,
        sha256: asset.digest.slice('sha256:'.length)
      }))
  }
}

describe('trusted release policy', () => {
  it('accepts only the configured Apple Team for Developer ID signatures', () => {
    const signature = `Authority=Developer ID Application: Jarvis Inc (${teamId})\nTeamIdentifier=${teamId}`
    expect(assertDeveloperIdSignature(signature, teamId, 'Jarvis.app').teamIdentifier).toBe(teamId)

    expect(() =>
      assertDeveloperIdSignature(
        'Authority=Developer ID Application: Other Inc (ZZ99YY88XX)\nTeamIdentifier=ZZ99YY88XX',
        teamId,
        'Jarvis.app'
      )
    ).toThrow(`expected ${teamId}`)
    expect(() =>
      assertDeveloperIdSignature(
        'Authority=Apple Development: Example\nTeamIdentifier=AB12CD34EF',
        teamId
      )
    ).toThrow('not signed with a Developer ID Application identity')
  })

  it('validates App Store Connect and Developer ID identifiers', () => {
    expect(requireAppleTeamId(teamId)).toBe(teamId)
    expect(requireAppleApiKeyId('1A2B3C4D5E')).toBe('1A2B3C4D5E')
    expect(requireAppleApiIssuer('01234567-89AB-CDEF-0123-456789ABCDEF')).toBe(
      '01234567-89ab-cdef-0123-456789abcdef'
    )
    expect(() => requireAppleApiKeyId('../escape')).toThrow()
    expect(() => requireAppleApiIssuer('not-a-uuid')).toThrow()
  })

  it('binds a draft contract to exactly four immutable asset digests', () => {
    const contract = contractFixture()
    expect(contract.assets).toHaveLength(4)
    expect(() =>
      assertReleaseMatchesContract(contract, {
        tagName: tag,
        isDraft: true,
        isPrerelease: false,
        assets: contract.assets.map((asset, index) =>
          index === 0 ? { ...asset, digest: `sha256:${'0'.repeat(64)}` } : asset
        )
      })
    ).toThrow('changed after draft verification')
  })

  it('verifies downloaded artifacts by physical-file size and SHA-256', () => {
    const contract = contractFixture()
    const root = mkdtempSync(join(tmpdir(), 'jarvis-release-assets-'))
    for (const asset of releaseAssets().filter((value) => value.name.includes('-arm64.'))) {
      writeFileSync(join(root, asset.name), asset.bytes)
    }
    expect(verifyLocalReleaseAssets(contract, root, 'arm64')).toHaveLength(2)

    writeFileSync(
      join(root, contract.assets.find((asset) => asset.name.endsWith('.dmg'))!.name),
      'x'
    )
    expect(() => verifyLocalReleaseAssets(contract, root, 'arm64')).toThrow(
      'does not match its immutable draft digest and size'
    )
  })

  it('rejects symlinked downloaded assets', () => {
    const contract = contractFixture()
    const root = mkdtempSync(join(tmpdir(), 'jarvis-release-symlink-'))
    const source = join(root, 'source')
    writeFileSync(source, 'source')
    for (const asset of contract.assets.filter((value) => value.name.includes('-arm64.'))) {
      symlinkSync(source, join(root, asset.name))
    }
    expect(() => verifyLocalReleaseAssets(contract, root, 'arm64')).toThrow(
      'must contain only physical files'
    )
  })

  it('renders notes only from both exact signed/notarized package summaries', () => {
    const contract = contractFixture()
    const notes = renderTrustedReleaseNotes({
      contract,
      arm64Evidence: packageEvidence(contract, 'arm64'),
      x64Evidence: packageEvidence(contract, 'x64'),
      existingBody: 'Generated change notes.',
      expectedTeamId: teamId,
      runUrl: 'https://github.com/Samin12/jarvis/actions/runs/123'
    })
    expect(notes).toContain('Trusted macOS release evidence')
    expect(notes).toContain(teamId)
    expect(notes).toContain(contract.commit)
    expect(notes).toContain('gh release verify-asset')
    expect(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).toContain(
      '"jarvis"'
    )
    expect(notes).toContain('Generated change notes.')

    expect(() =>
      renderTrustedReleaseNotes({
        contract,
        arm64Evidence: { ...packageEvidence(contract, 'arm64'), teamId: 'ZZ99YY88XX' },
        x64Evidence: packageEvidence(contract, 'x64'),
        existingBody: '',
        expectedTeamId: teamId,
        runUrl: 'https://github.com/Samin12/jarvis/actions/runs/123'
      })
    ).toThrow('Apple Team changed')
  })
})
