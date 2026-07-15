/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u
const APPLE_API_KEY_ID_PATTERN = /^[A-Z0-9]{10}$/u
const APPLE_API_ISSUER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const RELEASE_EVIDENCE_MARKER = '<!-- jarvis-trusted-release-evidence -->'

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

export function requireAppleTeamId(value) {
  const normalized = requiredString(value, 'APPLE_TEAM_ID')
  if (!APPLE_TEAM_ID_PATTERN.test(normalized)) {
    throw new Error('APPLE_TEAM_ID must be the 10-character Apple Developer Team ID')
  }
  return normalized
}

export function requireAppleApiKeyId(value) {
  const normalized = requiredString(value, 'APPLE_API_KEY_ID')
  if (!APPLE_API_KEY_ID_PATTERN.test(normalized)) {
    throw new Error('APPLE_API_KEY_ID must be a 10-character App Store Connect key ID')
  }
  return normalized
}

export function requireAppleApiIssuer(value) {
  const normalized = requiredString(value, 'APPLE_API_ISSUER')
  if (!APPLE_API_ISSUER_PATTERN.test(normalized)) {
    throw new Error('APPLE_API_ISSUER must be an App Store Connect issuer UUID')
  }
  return normalized.toLowerCase()
}

export function parseCodeSignatureMetadata(signature) {
  const text = requiredString(signature, 'codesign metadata')
  const authorities = [...text.matchAll(/^Authority=(.+)$/gmu)].map((match) => match[1].trim())
  const teamIdentifier = text.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim() ?? null
  return { authorities, teamIdentifier }
}

export function assertDeveloperIdSignature(signature, expectedTeamId, label = 'signed code') {
  const expectedTeam = requireAppleTeamId(expectedTeamId)
  const metadata = parseCodeSignatureMetadata(signature)
  const leafAuthority = metadata.authorities[0] ?? ''

  if (!leafAuthority.startsWith('Developer ID Application:')) {
    throw new Error(`${label} is not signed with a Developer ID Application identity`)
  }
  if (metadata.teamIdentifier !== expectedTeam) {
    throw new Error(
      `${label} is signed by Apple Team ${metadata.teamIdentifier ?? 'unknown'}, expected ${expectedTeam}`
    )
  }

  const authorityTeam = leafAuthority.match(/\(([A-Z0-9]{10})\)\s*$/u)?.[1]
  if (authorityTeam && authorityTeam !== expectedTeam) {
    throw new Error(
      `${label} leaf certificate belongs to Apple Team ${authorityTeam}, expected ${expectedTeam}`
    )
  }
  return metadata
}

export function expectedReleaseAssetNames(packageName, version) {
  const name = requiredString(packageName, 'package name')
  const releaseVersion = requiredString(version, 'package version')
  return ['arm64', 'x64'].flatMap((arch) => [
    `${name}-${releaseVersion}-${arch}.dmg`,
    `${name}-${releaseVersion}-${arch}.zip`
  ])
}

function normalizeReleaseAssets(assets) {
  if (!Array.isArray(assets)) throw new Error('release assets must be an array')
  return assets
    .map((asset) => {
      const name = requiredString(asset?.name, 'release asset name')
      const digest = requiredString(asset?.digest, `${name} digest`).toLowerCase()
      if (!DIGEST_PATTERN.test(digest)) {
        throw new Error(`${name} must have a GitHub sha256 digest`)
      }
      if (!Number.isSafeInteger(asset?.size) || asset.size <= 0) {
        throw new Error(`${name} must have a positive integer size`)
      }
      return { name, digest, size: asset.size }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function assertExactNames(actualNames, expectedNames, label) {
  const actual = [...actualNames].sort()
  const expected = [...expectedNames].sort()
  if (new Set(actual).size !== actual.length || actual.join('\n') !== expected.join('\n')) {
    throw new Error(
      `${label} must contain exactly ${expected.join(', ')}; found ${actual.join(', ') || 'none'}`
    )
  }
}

export function createReleaseContract({ releaseView, tag, commit, packageJson, repository }) {
  const version = requiredString(packageJson?.version, 'package.json version')
  const packageName = requiredString(packageJson?.name, 'package.json name')
  const expectedTag = `v${version}`
  const normalizedTag = requiredString(tag, 'release tag')
  const normalizedCommit = requiredString(commit, 'release commit').toLowerCase()
  const normalizedRepository = requiredString(repository, 'GitHub repository')

  if (normalizedTag !== expectedTag) {
    throw new Error(`release tag must be ${expectedTag} for package version ${version}`)
  }
  if (!COMMIT_PATTERN.test(normalizedCommit)) throw new Error('release commit must be a full SHA-1')
  if (!REPOSITORY_PATTERN.test(normalizedRepository)) {
    throw new Error('GitHub repository must be OWNER/REPO')
  }
  if (releaseView?.tagName !== normalizedTag) throw new Error('draft release tag does not match')
  if (releaseView?.isDraft !== true)
    throw new Error(`${normalizedTag} must still be a draft release`)

  const assets = normalizeReleaseAssets(releaseView.assets)
  assertExactNames(
    assets.map((asset) => asset.name),
    expectedReleaseAssetNames(packageName, version),
    `${normalizedTag} draft`
  )

  return {
    schemaVersion: 1,
    repository: normalizedRepository,
    tag: normalizedTag,
    commit: normalizedCommit,
    packageName,
    version,
    prerelease: releaseView.isPrerelease === true,
    assets
  }
}

export function assertReleaseMatchesContract(contract, releaseView) {
  if (contract?.schemaVersion !== 1) throw new Error('unsupported release contract schema')
  if (releaseView?.tagName !== contract.tag) throw new Error('live draft release tag changed')
  if (releaseView?.isDraft !== true) throw new Error(`${contract.tag} is no longer a draft`)
  if ((releaseView?.isPrerelease === true) !== contract.prerelease) {
    throw new Error(`${contract.tag} prerelease state changed`)
  }

  const assets = normalizeReleaseAssets(releaseView.assets)
  assertExactNames(
    assets.map((asset) => asset.name),
    contract.assets.map((asset) => asset.name),
    `${contract.tag} live draft`
  )
  for (const expected of contract.assets) {
    const actual = assets.find((asset) => asset.name === expected.name)
    if (!actual || actual.digest !== expected.digest || actual.size !== expected.size) {
      throw new Error(`${expected.name} changed after draft verification`)
    }
  }
  return assets
}

export function sha256PhysicalFile(requestedPath) {
  const path = resolve(requestedPath)
  const before = lstatSync(path)
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error(`${path} must be a single-link physical file`)
  }

  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(descriptor)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`${path} changed while it was opened`)
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    while (true) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      hash.update(buffer.subarray(0, bytes))
    }
    return { bytes: opened.size, sha256: hash.digest('hex') }
  } finally {
    closeSync(descriptor)
  }
}

export function verifyLocalReleaseAssets(contract, directory, arch = null) {
  if (arch !== null && !['arm64', 'x64'].includes(arch)) {
    throw new Error('release asset architecture must be arm64 or x64')
  }
  const expected = contract.assets.filter((asset) => !arch || asset.name.includes(`-${arch}.`))
  const root = resolve(directory)
  const entries = readdirSync(root, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('release asset directory must contain only physical files')
  }
  assertExactNames(
    entries.map((entry) => entry.name),
    expected.map((asset) => asset.name),
    `${arch ?? 'all'} downloaded assets`
  )

  return expected.map((asset) => {
    const evidence = sha256PhysicalFile(join(root, asset.name))
    const expectedSha256 = DIGEST_PATTERN.exec(asset.digest)?.[1]
    if (evidence.sha256 !== expectedSha256 || evidence.bytes !== asset.size) {
      throw new Error(`${asset.name} does not match its immutable draft digest and size`)
    }
    return { name: asset.name, ...evidence }
  })
}

function normalizePackageEvidence(summary, contract, expectedTeamId, arch) {
  if (summary?.schemaVersion !== 1) throw new Error(`${arch} evidence schema is unsupported`)
  if (summary.mode !== 'release' || summary.arch !== arch) {
    throw new Error(`${arch} evidence must describe the release ${arch} package`)
  }
  if (summary.packageVersion !== contract.version) {
    throw new Error(`${arch} evidence package version changed`)
  }
  if (summary.teamId !== expectedTeamId) throw new Error(`${arch} evidence Apple Team changed`)
  if (summary.signature !== 'Developer ID + hardened runtime') {
    throw new Error(`${arch} evidence is missing the Developer ID result`)
  }
  if (summary.notarization !== 'Gatekeeper accepted + stapled ticket') {
    throw new Error(`${arch} evidence is missing the notarization result`)
  }
  if (summary.copiedInstall !== 'quarantined copies passed Gatekeeper and onboarding smoke') {
    throw new Error(`${arch} evidence is missing copied-install acceptance`)
  }

  const artifacts = normalizeReleaseAssets(
    (summary.artifacts ?? []).map((artifact) => ({
      name: artifact.name,
      digest: `sha256:${artifact.sha256}`,
      size: artifact.bytes
    }))
  )
  const expected = contract.assets.filter((asset) => asset.name.includes(`-${arch}.`))
  assertExactNames(
    artifacts.map((artifact) => artifact.name),
    expected.map((asset) => asset.name),
    `${arch} verification evidence`
  )
  for (const asset of expected) {
    const verified = artifacts.find((candidate) => candidate.name === asset.name)
    if (!verified || verified.digest !== asset.digest || verified.size !== asset.size) {
      throw new Error(`${asset.name} verification evidence does not match the release contract`)
    }
  }
  return artifacts
}

function escapeMarkdown(value) {
  return value.replaceAll('|', '\\|')
}

export function renderTrustedReleaseNotes({
  contract,
  arm64Evidence,
  x64Evidence,
  existingBody,
  expectedTeamId,
  runUrl
}) {
  const teamId = requireAppleTeamId(expectedTeamId)
  const workflowUrl = requiredString(runUrl, 'verification workflow URL')
  if (!/^https:\/\/github\.com\//u.test(workflowUrl)) {
    throw new Error('verification workflow URL must be a GitHub HTTPS URL')
  }
  const repository = requiredString(contract.repository, 'release contract repository')
  const arm64Assets = normalizePackageEvidence(arm64Evidence, contract, teamId, 'arm64')
  const x64Assets = normalizePackageEvidence(x64Evidence, contract, teamId, 'x64')
  const evidenceAssets = [...arm64Assets, ...x64Assets].sort((a, b) => a.name.localeCompare(b.name))

  if (typeof existingBody !== 'string') throw new Error('existing release notes must be text')
  if (existingBody.includes(RELEASE_EVIDENCE_MARKER)) {
    throw new Error('trusted release evidence is already present')
  }

  const rows = evidenceAssets
    .map(
      (asset) =>
        `| \`${escapeMarkdown(asset.name)}\` | ${asset.bytes} | \`${asset.digest.slice(7)}\` |`
    )
    .join('\n')
  const sourceUrl = `https://github.com/${repository}/commit/${contract.commit}`

  return `${RELEASE_EVIDENCE_MARKER}
## Trusted macOS release evidence

This release was built from [\`${contract.commit}\`](${sourceUrl}) on native arm64 and Intel
GitHub-hosted macOS runners. Both packages passed exact-architecture checks, Developer ID signing
for Apple Team \`${teamId}\`, hardened runtime checks, Apple notarization and stapling, archive
parity, credential scanning, and copied-install onboarding smoke under quarantine.

- Verification run: [GitHub Actions](${workflowUrl})
- Release policy: immutable tag and assets with GitHub release attestation

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
${rows}

After downloading, verify an asset with \`gh release verify-asset ${contract.tag} <file> --repo ${repository}\`.

${existingBody.trim() ? `---\n\n${existingBody.trim()}\n` : ''}`
}

function parseOptions(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value || values.has(key)) {
      throw new Error(`Invalid or duplicate option: ${key ?? 'missing'}`)
    }
    values.set(key, value)
  }
  return {
    required(name) {
      return requiredString(values.get(name), name)
    },
    optional(name) {
      return values.get(name) ?? null
    }
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'))
}

export async function runReleasePolicyCli(argv) {
  const [command, ...rest] = argv
  const options = parseOptions(rest)

  if (command === 'capture') {
    const contract = createReleaseContract({
      releaseView: readJson(options.required('--release-view')),
      tag: options.required('--tag'),
      commit: options.required('--commit'),
      packageJson: readJson(options.required('--package-json')),
      repository: options.required('--repository')
    })
    const out = resolve(options.required('--out'))
    writeFileSync(out, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600 })
    console.log(`Captured immutable draft contract for ${contract.tag}`)
    return
  }

  if (command === 'assert-live-draft') {
    const contract = readJson(options.required('--contract'))
    assertReleaseMatchesContract(contract, readJson(options.required('--release-view')))
    console.log(`Live draft ${contract.tag} still matches its release contract`)
    return
  }

  if (command === 'verify-assets') {
    const contract = readJson(options.required('--contract'))
    const evidence = verifyLocalReleaseAssets(
      contract,
      options.required('--dir'),
      options.optional('--arch')
    )
    console.log(JSON.stringify(evidence, null, 2))
    return
  }

  if (command === 'render-notes') {
    const notes = renderTrustedReleaseNotes({
      contract: readJson(options.required('--contract')),
      arm64Evidence: readJson(options.required('--arm64-evidence')),
      x64Evidence: readJson(options.required('--x64-evidence')),
      existingBody: readFileSync(resolve(options.required('--existing-body')), 'utf8'),
      expectedTeamId: options.required('--team-id'),
      runUrl: options.required('--run-url')
    })
    const out = resolve(options.required('--out'))
    writeFileSync(out, notes, { mode: 0o600 })
    console.log(`Rendered trusted release evidence in ${basename(out)}`)
    return
  }

  throw new Error(
    'Usage: release-policy.mjs capture|assert-live-draft|verify-assets|render-notes [options]'
  )
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await runReleasePolicyCli(process.argv.slice(2))
}
