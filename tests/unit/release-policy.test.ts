import { createHash } from 'node:crypto'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertDeveloperIdSignature,
  assertPublishedReleaseMatchesContract,
  assertReleaseMatchesContract,
  createReleaseContract,
  expectedReleaseAssetNames,
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

function releaseAssets(): FixtureAsset[] {
  return expectedReleaseAssetNames('jarvis', version).map((name) => {
    const bytes = Buffer.from(`receipt:${name}`)
    return {
      name,
      size: bytes.byteLength,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      bytes
    }
  })
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
      name: `Jarvis ${tag}`,
      body: 'Bound release notes.\n',
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

  it('binds a draft contract to metadata and exactly 11 immutable asset digests', () => {
    const contract = contractFixture()
    expect(contract).toMatchObject({
      schemaVersion: 2,
      title: `Jarvis ${tag}`,
      assets: expect.any(Array)
    })
    expect(contract.assets).toHaveLength(11)
    expect(() =>
      assertReleaseMatchesContract(contract, {
        tagName: tag,
        name: contract.title,
        body: 'Bound release notes.\n',
        isDraft: true,
        isPrerelease: false,
        assets: contract.assets.map((asset, index) =>
          index === 0 ? { ...asset, digest: `sha256:${'0'.repeat(64)}` } : asset
        )
      })
    ).toThrow('changed after draft verification')

    expect(() =>
      assertReleaseMatchesContract(contract, {
        tagName: tag,
        name: contract.title,
        body: 'Changed notes.\n',
        isDraft: true,
        isPrerelease: false,
        assets: contract.assets
      })
    ).toThrow('release notes changed')
  })

  it('accepts publication only when metadata and all assets become immutable unchanged', () => {
    const contract = contractFixture()
    expect(
      assertPublishedReleaseMatchesContract(contract, {
        tagName: tag,
        name: contract.title,
        body: 'Bound release notes.\n',
        isDraft: false,
        isImmutable: true,
        isPrerelease: false,
        assets: contract.assets
      })
    ).toHaveLength(11)
    expect(() =>
      assertPublishedReleaseMatchesContract(contract, {
        tagName: tag,
        name: contract.title,
        body: 'Bound release notes.\n',
        isDraft: false,
        isImmutable: false,
        isPrerelease: false,
        assets: contract.assets
      })
    ).toThrow('is not immutable')
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
})
