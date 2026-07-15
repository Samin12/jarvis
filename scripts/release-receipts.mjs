/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  expectedReleaseAssetNames,
  requireAppleTeamId,
  sha256PhysicalFile
} from './release-policy.mjs'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const RECEIPT_MARKER = '<!-- jarvis-trusted-release-evidence -->'

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256Text(value) {
  if (typeof value !== 'string') throw new Error('release notes must be text')
  return sha256Buffer(Buffer.from(value, 'utf8'))
}

function readPhysicalJson(path, label) {
  sha256PhysicalFile(path)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : error}`)
  }
}

function writeNewFile(path, contents, mode = 0o600) {
  const output = resolve(path)
  mkdirSync(dirname(output), { recursive: true })
  if (existsSync(output) || lstatExists(output)) {
    throw new Error(`Refusing to overwrite existing output: ${output}`)
  }
  const descriptor = openSync(
    output,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    mode
  )
  let completed = false
  try {
    writeFileSync(descriptor, contents)
    completed = true
  } finally {
    // writeFileSync does not close descriptors supplied by the caller.
    closeSync(descriptor)
    if (!completed) {
      try {
        unlinkSync(output)
      } catch {
        // Preserve the original write error; the caller also tracks successful outputs.
      }
    }
  }
  return output
}

function lstatExists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false
    throw error
  }
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

function assertExactPhysicalFiles(directory, expectedNames, label) {
  const root = resolve(directory)
  const rootInfo = lstatSync(root)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`${label} must be a physical directory`)
  }
  const entries = readdirSync(root, { withFileTypes: true })
  assertExactNames(
    entries.map((entry) => entry.name),
    expectedNames,
    label
  )
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${label} must contain only physical files`)
    }
    sha256PhysicalFile(join(root, entry.name))
  }
  return root
}

function isWithinDirectory(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function removeCreatedFiles(paths) {
  for (const path of [...paths].reverse()) {
    try {
      const info = lstatSync(path)
      if (!info.isDirectory()) unlinkSync(path)
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error
    }
  }
}

function packageMetadata(packageJson) {
  const packageName = requiredString(packageJson?.name, 'package name')
  const version = requiredString(packageJson?.version, 'package version')
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(packageName)) {
    throw new Error('package name is unsafe for release asset names')
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('package version is not a supported semantic version')
  }
  return { packageName, version }
}

export function expectedReleaseReceiptNames(packageName, version) {
  return expectedReleaseAssetNames(packageName, version)
}

function receiptLayout(packageName, version) {
  const names = expectedReleaseReceiptNames(packageName, version)
  if (names.length !== 11) throw new Error('trusted release policy must define exactly 11 assets')
  return {
    all: names,
    evidence: names.slice(0, 9),
    manifest: names[9],
    checksums: names[10],
    installers: names.slice(0, 4),
    verification: names.slice(4, 6),
    sbom: names[6],
    licenses: names[7],
    notices: names[8]
  }
}

function normalizeLicense(item, componentLabel) {
  if (item && typeof item.expression === 'string' && item.expression.trim()) {
    return { kind: 'expression', value: item.expression.trim() }
  }
  const license = item?.license
  if (license && typeof license.id === 'string' && license.id.trim()) {
    return { kind: 'spdx', value: license.id.trim() }
  }
  if (license && typeof license.name === 'string' && license.name.trim()) {
    return { kind: 'name', value: license.name.trim() }
  }
  throw new Error(`${componentLabel} is missing usable CycloneDX license metadata`)
}

function licenseInventoryFromSbom(sbom, sbomName, sbomSha256, expectedPackageName) {
  if (sbom?.bomFormat !== 'CycloneDX' || typeof sbom.specVersion !== 'string') {
    throw new Error('release SBOM must be CycloneDX')
  }
  if (!Array.isArray(sbom.components) || sbom.components.length === 0) {
    throw new Error('release SBOM must include dependency components')
  }
  if (sbom?.metadata?.component?.name && sbom.metadata.component.name !== expectedPackageName) {
    throw new Error('release SBOM describes a different application')
  }

  const components = sbom.components.map((component) => {
    const name = requiredString(component?.name, 'SBOM component name')
    const group = typeof component.group === 'string' ? component.group.trim() : ''
    const qualifiedName = group ? `${group}/${name}` : name
    const version = requiredString(component?.version, `${qualifiedName} version`)
    const purl =
      typeof component.purl === 'string' && component.purl.trim() ? component.purl.trim() : null
    if (!Array.isArray(component.licenses) || component.licenses.length === 0) {
      throw new Error(`${qualifiedName}@${version} is missing CycloneDX license metadata`)
    }
    const licenses = component.licenses
      .map((license) => normalizeLicense(license, `${qualifiedName}@${version}`))
      .sort((left, right) =>
        `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`)
      )
    return { name: qualifiedName, version, purl, licenses }
  })
  components.sort((left, right) =>
    `${left.purl ?? left.name}@${left.version}`.localeCompare(
      `${right.purl ?? right.name}@${right.version}`
    )
  )
  const keys = components.map(
    (component) => component.purl ?? `${component.name}@${component.version}`
  )
  if (new Set(keys).size !== keys.length)
    throw new Error('release SBOM contains duplicate components')

  return {
    schemaVersion: 1,
    format: 'jarvis-cyclonedx-license-inventory',
    source: {
      name: sbomName,
      sha256: sbomSha256,
      bomFormat: sbom.bomFormat,
      specVersion: sbom.specVersion,
      serialNumber: typeof sbom.serialNumber === 'string' ? sbom.serialNumber : null
    },
    componentCount: components.length,
    components
  }
}

function validateLicenseInventory(sbomPath, licensesPath, packageName) {
  const sbomEvidence = sha256PhysicalFile(sbomPath)
  const sbom = readPhysicalJson(sbomPath, 'release SBOM')
  const expected = licenseInventoryFromSbom(
    sbom,
    basename(sbomPath),
    sbomEvidence.sha256,
    packageName
  )
  const actual = readPhysicalJson(licensesPath, 'release license inventory')
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('release license inventory does not exactly match the CycloneDX SBOM')
  }
  return { sbom, inventory: actual }
}

function runUnzip(args, encoding = 'utf8') {
  const result = spawnSync('unzip', args, {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000
  })
  if (result.error || result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .map((value) => String(value))
      .join('\n')
      .trim()
    throw new Error(`unzip ${args.join(' ')} failed${detail ? `: ${detail.slice(-2000)}` : ''}`)
  }
  return result.stdout
}

function verifyNoticesArchive(path) {
  sha256PhysicalFile(path)
  const names = String(runUnzip(['-Z1', path]))
    .split(/\r?\n/u)
    .filter(Boolean)
  if (names.length === 0 || new Set(names).size !== names.length) {
    throw new Error('third-party notices archive is empty or contains duplicate entries')
  }
  for (const name of names) {
    const path = name.endsWith('/') ? name.slice(0, -1) : name
    if (
      path.includes('\\') ||
      path.startsWith('/') ||
      path.split('/').some((segment) => segment === '..' || segment === '')
    ) {
      throw new Error(`third-party notices archive contains an unsafe path: ${name}`)
    }
  }
  const files = names.filter((name) => !name.endsWith('/')).sort()
  if (!files.includes('manifest.json')) {
    throw new Error('third-party notices archive is missing manifest.json')
  }
  const manifestBuffer = runUnzip(['-p', path, 'manifest.json'], null)
  let manifest
  try {
    manifest = JSON.parse(Buffer.from(manifestBuffer).toString('utf8'))
  } catch (error) {
    throw new Error(
      `third-party notices manifest is invalid: ${error instanceof Error ? error.message : error}`
    )
  }
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.format !== 'jarvis-third-party-legal-notices' ||
    !Array.isArray(manifest.components) ||
    !Number.isSafeInteger(manifest.componentCount) ||
    manifest.componentCount !== manifest.components.length ||
    !Number.isSafeInteger(manifest.fileCount) ||
    manifest?.codexEvidence?.tag !== 'rust-v0.144.3'
  ) {
    throw new Error('third-party notices manifest schema is invalid')
  }
  const payload = manifest.components.flatMap((component) => {
    if (!Array.isArray(component.files)) throw new Error('legal component files are missing')
    return component.files.map((file) => ({
      path: requiredString(file?.path, 'legal payload path'),
      bytes: file?.bytes,
      sha256: file?.sha256
    }))
  })
  if (manifest.fileCount !== payload.length) {
    throw new Error('third-party notices manifest file count is invalid')
  }
  assertExactNames(
    files,
    ['manifest.json', ...payload.map((file) => file.path)],
    'third-party notices archive'
  )
  for (const file of payload) {
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`${file.path} has invalid legal-manifest evidence`)
    }
    const contents = Buffer.from(runUnzip(['-p', path, file.path], null))
    if (contents.byteLength !== file.bytes || sha256Buffer(contents) !== file.sha256) {
      throw new Error(`${file.path} does not match the legal manifest`)
    }
  }
  return {
    componentCount: manifest.componentCount,
    fileCount: payload.length,
    codexTag: manifest.codexEvidence.tag,
    manifestBytes: Buffer.from(manifestBuffer).byteLength,
    manifestSha256: sha256Buffer(Buffer.from(manifestBuffer))
  }
}

function normalizeArtifactEvidence(artifacts, label) {
  if (!Array.isArray(artifacts)) throw new Error(`${label} artifacts are missing`)
  return artifacts
    .map((artifact) => {
      const name = requiredString(artifact?.name, `${label} artifact name`)
      if (!Number.isSafeInteger(artifact?.bytes) || artifact.bytes <= 0) {
        throw new Error(`${name} has an invalid byte count`)
      }
      if (!SHA256_PATTERN.test(artifact?.sha256)) throw new Error(`${name} has an invalid SHA-256`)
      return { name, bytes: artifact.bytes, sha256: artifact.sha256 }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function validatePackageSummary(summaryPath, assetsRoot, context) {
  const summary = readPhysicalJson(summaryPath, `${context.arch} package verification`)
  if (summary?.schemaVersion !== 1)
    throw new Error(`${context.arch} verification schema is invalid`)
  if (summary.packageVersion !== context.version || summary.arch !== context.arch) {
    throw new Error(`${context.arch} verification describes a different package`)
  }
  if (summary.mode !== 'release' || summary.teamId !== context.teamId) {
    throw new Error(`${context.arch} verification is not the trusted release build`)
  }
  if (summary.signature !== 'Developer ID + hardened runtime') {
    throw new Error(`${context.arch} verification is missing Developer ID evidence`)
  }
  if (summary.notarization !== 'Gatekeeper accepted + stapled ticket') {
    throw new Error(`${context.arch} verification is missing notarization evidence`)
  }
  if (summary.copiedInstall !== 'quarantined copies passed Gatekeeper and onboarding smoke') {
    throw new Error(`${context.arch} verification is missing copied-install evidence`)
  }
  if (!Number.isSafeInteger(summary.signedMachOCount) || summary.signedMachOCount <= 0) {
    throw new Error(`${context.arch} verification is missing nested Mach-O evidence`)
  }
  if (typeof summary.codex !== 'string' || !/^codex-cli\s+\d/u.test(summary.codex)) {
    throw new Error(`${context.arch} verification is missing bundled Codex evidence`)
  }
  if (!Array.isArray(summary.nativeHelpers) || summary.nativeHelpers.length !== 2) {
    throw new Error(`${context.arch} verification must describe exactly two native helpers`)
  }
  for (const helper of summary.nativeHelpers) {
    requiredString(helper?.name, `${context.arch} native-helper name`)
    if (
      !Number.isSafeInteger(helper?.bytes) ||
      helper.bytes <= 0 ||
      !SHA256_PATTERN.test(helper?.sha256)
    ) {
      throw new Error(`${context.arch} native-helper evidence is invalid`)
    }
  }
  const legal = summary.legalNotices
  if (
    legal?.schemaVersion !== 1 ||
    legal?.codexTag !== 'rust-v0.144.3' ||
    !Number.isSafeInteger(legal?.componentCount) ||
    legal.componentCount < 1 ||
    !Number.isSafeInteger(legal?.fileCount) ||
    legal.fileCount < 1 ||
    !SHA256_PATTERN.test(legal?.manifestSha256)
  ) {
    throw new Error(`${context.arch} verification is missing bundled legal-notice evidence`)
  }
  if (
    legal.componentCount !== context.legalNotices.componentCount ||
    legal.fileCount !== context.legalNotices.fileCount ||
    legal.codexTag !== context.legalNotices.codexTag ||
    legal.manifestBytes !== context.legalNotices.manifestBytes ||
    legal.manifestSha256 !== context.legalNotices.manifestSha256
  ) {
    throw new Error(
      `${context.arch} bundled legal-notice evidence does not match the release archive`
    )
  }

  const artifacts = normalizeArtifactEvidence(summary.artifacts, `${context.arch} verification`)
  const expected = context.installerNames.filter((name) => name.includes(`-${context.arch}.`))
  assertExactNames(
    artifacts.map((artifact) => artifact.name),
    expected,
    `${context.arch} verification artifacts`
  )
  for (const artifact of artifacts) {
    const physical = sha256PhysicalFile(join(assetsRoot, artifact.name))
    if (physical.bytes !== artifact.bytes || physical.sha256 !== artifact.sha256) {
      throw new Error(`${artifact.name} does not match its package verification record`)
    }
  }
  return summary
}

function assetRole(name, layout) {
  if (layout.installers.includes(name))
    return name.endsWith('.dmg') ? 'installer-dmg' : 'installer-zip'
  if (layout.verification.includes(name)) return 'native-verification'
  if (name === layout.sbom) return 'cyclonedx-sbom'
  if (name === layout.licenses) return 'license-inventory'
  if (name === layout.notices) return 'third-party-notices'
  throw new Error(`Unknown release evidence asset: ${name}`)
}

function releaseEvidence(root, names, layout) {
  return names.map((name) => ({
    name,
    role: assetRole(name, layout),
    ...sha256PhysicalFile(join(root, name))
  }))
}

function normalizeMetadata({ packageJson, tag, commit, repository }) {
  const { packageName, version } = packageMetadata(packageJson)
  const normalizedTag = requiredString(tag, 'release tag')
  if (normalizedTag !== `v${version}`) throw new Error(`release tag must be v${version}`)
  const normalizedCommit = requiredString(commit, 'release commit').toLowerCase()
  if (!COMMIT_PATTERN.test(normalizedCommit)) throw new Error('release commit must be a full SHA-1')
  const normalizedRepository = requiredString(repository, 'GitHub repository')
  if (!REPOSITORY_PATTERN.test(normalizedRepository)) {
    throw new Error('GitHub repository must be OWNER/REPO')
  }
  return {
    packageName,
    version,
    tag: normalizedTag,
    commit: normalizedCommit,
    repository: normalizedRepository
  }
}

function renderReleaseNotes(metadata, evidence, teamId, runUrl) {
  const workflowUrl = requiredString(runUrl, 'release workflow URL')
  if (!/^https:\/\/github\.com\//u.test(workflowUrl)) {
    throw new Error('release workflow URL must be a GitHub HTTPS URL')
  }
  const rows = evidence
    .map((asset) => `| \`${asset.name}\` | ${asset.bytes} | \`${asset.sha256}\` |`)
    .join('\n')
  return `${RECEIPT_MARKER}
## Trusted macOS release evidence

Jarvis ${metadata.version} was built from [\`${metadata.commit}\`](https://github.com/${metadata.repository}/commit/${metadata.commit}) on native Apple Silicon and Intel GitHub-hosted macOS runners. Both installers passed exact-architecture checks, Developer ID signing for Apple Team \`${teamId}\`, hardened-runtime and nested-signature checks, Apple notarization and stapling, credential scanning, archive parity, and copied-install onboarding smoke under quarantine.

- Verification run: [GitHub Actions](${workflowUrl})
- Supply-chain receipts: CycloneDX SBOM, normalized license inventory, bundled third-party notices, immutable release manifest, and \`SHA256SUMS\`
- Independent verification: \`gh release verify-asset ${metadata.tag} <file> --repo ${metadata.repository}\`

| Immutable asset | Bytes | SHA-256 |
| --- | ---: | --- |
${rows}`
}

function parseChecksumFile(text) {
  const records = String(text)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-9a-f]{64}) {2}([^\n]+)$/u.exec(line)
      if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`)
      return { sha256: match[1], name: match[2] }
    })
  if (new Set(records.map((record) => record.name)).size !== records.length) {
    throw new Error('SHA256SUMS contains duplicate asset names')
  }
  return records
}

function verifyReceiptDirectory({ assetsDir, metadata, releaseView }) {
  const layout = receiptLayout(metadata.packageName, metadata.version)
  const root = assertExactPhysicalFiles(assetsDir, layout.all, 'trusted release receipt directory')
  const manifestPath = join(root, layout.manifest)
  const manifest = readPhysicalJson(manifestPath, 'trusted release manifest')
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.format !== 'jarvis-immutable-release-manifest' ||
    manifest.repository !== metadata.repository ||
    manifest.tag !== metadata.tag ||
    manifest.commit !== metadata.commit ||
    manifest.packageName !== metadata.packageName ||
    manifest.version !== metadata.version
  ) {
    throw new Error('trusted release manifest metadata does not match the release')
  }
  const teamId = requireAppleTeamId(manifest.teamId)
  if (!/^https:\/\/github\.com\//u.test(manifest.buildRunUrl)) {
    throw new Error('trusted release manifest build URL is invalid')
  }
  const title = requiredString(releaseView?.name, 'release title')
  if (title !== manifest.title) throw new Error('release title does not match the trusted manifest')
  if (releaseView?.tagName !== metadata.tag) throw new Error('release view tag does not match')
  if (sha256Text(releaseView?.body) !== manifest.bodySha256) {
    throw new Error('release notes do not match the trusted manifest')
  }

  const expectedEvidence = releaseEvidence(root, layout.evidence, layout)
  if (JSON.stringify(manifest.assets) !== JSON.stringify(expectedEvidence)) {
    throw new Error('trusted release manifest asset evidence changed')
  }
  validateLicenseInventory(
    join(root, layout.sbom),
    join(root, layout.licenses),
    metadata.packageName
  )
  const notices = verifyNoticesArchive(join(root, layout.notices))
  for (const arch of ['arm64', 'x64']) {
    validatePackageSummary(
      join(root, `${metadata.packageName}-${metadata.version}-${arch}-verification.json`),
      root,
      { ...metadata, arch, teamId, installerNames: layout.installers, legalNotices: notices }
    )
  }

  const checksumRecords = parseChecksumFile(readFileSync(join(root, layout.checksums), 'utf8'))
  const checksumNames = [...layout.evidence, layout.manifest]
  assertExactNames(
    checksumRecords.map((record) => record.name),
    checksumNames,
    'SHA256SUMS'
  )
  for (const record of checksumRecords) {
    if (sha256PhysicalFile(join(root, record.name)).sha256 !== record.sha256) {
      throw new Error(`${record.name} does not match SHA256SUMS`)
    }
  }

  return {
    schemaVersion: 1,
    assetCount: layout.all.length,
    manifestSha256: sha256PhysicalFile(manifestPath).sha256,
    checksumsSha256: sha256PhysicalFile(join(root, layout.checksums)).sha256,
    licenseComponentCount: readPhysicalJson(join(root, layout.licenses), 'license inventory')
      .componentCount,
    legalComponentCount: notices.componentCount,
    teamId
  }
}

export function prepareReleaseReceipts({
  assetsDir,
  packageJson,
  tag,
  commit,
  repository,
  teamId,
  runUrl,
  titleOut,
  bodyOut
}) {
  const metadata = normalizeMetadata({ packageJson, tag, commit, repository })
  const releaseTeamId = requireAppleTeamId(teamId)
  const layout = receiptLayout(metadata.packageName, metadata.version)
  const root = resolve(assetsDir)
  const resolvedTitleOut = resolve(titleOut)
  const resolvedBodyOut = resolve(bodyOut)
  if (
    resolvedTitleOut === resolvedBodyOut ||
    isWithinDirectory(root, resolvedTitleOut) ||
    isWithinDirectory(root, resolvedBodyOut)
  ) {
    throw new Error(
      'release title and notes outputs must be distinct and outside the immutable asset directory'
    )
  }
  const initialAssets = layout.evidence.filter((name) => name !== layout.licenses)
  assertExactPhysicalFiles(root, initialAssets, 'pre-receipt release asset directory')
  const createdFiles = []
  const writeTrackedFile = (path, contents) => {
    const output = writeNewFile(path, contents)
    createdFiles.push(output)
  }

  try {
    const sbomPath = join(root, layout.sbom)
    const sbomEvidence = sha256PhysicalFile(sbomPath)
    const inventory = licenseInventoryFromSbom(
      readPhysicalJson(sbomPath, 'release SBOM'),
      layout.sbom,
      sbomEvidence.sha256,
      metadata.packageName
    )
    writeTrackedFile(join(root, layout.licenses), `${JSON.stringify(inventory, null, 2)}\n`)
    assertExactPhysicalFiles(root, layout.evidence, 'release evidence directory')
    validateLicenseInventory(sbomPath, join(root, layout.licenses), metadata.packageName)
    const notices = verifyNoticesArchive(join(root, layout.notices))
    for (const arch of ['arm64', 'x64']) {
      validatePackageSummary(
        join(root, `${metadata.packageName}-${metadata.version}-${arch}-verification.json`),
        root,
        {
          ...metadata,
          arch,
          teamId: releaseTeamId,
          installerNames: layout.installers,
          legalNotices: notices
        }
      )
    }

    const evidence = releaseEvidence(root, layout.evidence, layout)
    const title = `Jarvis ${metadata.tag}`
    const body = renderReleaseNotes(metadata, evidence, releaseTeamId, runUrl)
    const manifest = {
      schemaVersion: 1,
      format: 'jarvis-immutable-release-manifest',
      repository: metadata.repository,
      tag: metadata.tag,
      commit: metadata.commit,
      packageName: metadata.packageName,
      version: metadata.version,
      title,
      bodySha256: sha256Text(body),
      teamId: releaseTeamId,
      buildRunUrl: requiredString(runUrl, 'release workflow URL'),
      assets: evidence
    }
    writeTrackedFile(join(root, layout.manifest), `${JSON.stringify(manifest, null, 2)}\n`)
    const checksumNames = [...layout.evidence, layout.manifest]
    const checksumText = `${checksumNames
      .map((name) => `${sha256PhysicalFile(join(root, name)).sha256}  ${name}`)
      .join('\n')}\n`
    writeTrackedFile(join(root, layout.checksums), checksumText)
    writeTrackedFile(resolvedTitleOut, `${title}\n`)
    writeTrackedFile(resolvedBodyOut, body)

    return verifyReceiptDirectory({
      assetsDir: root,
      metadata,
      releaseView: { tagName: metadata.tag, name: title, body }
    })
  } catch (error) {
    removeCreatedFiles(createdFiles)
    throw error
  }
}

export function verifyReleaseReceipts({
  assetsDir,
  packageJson,
  tag,
  commit,
  repository,
  releaseView
}) {
  const metadata = normalizeMetadata({ packageJson, tag, commit, repository })
  return verifyReceiptDirectory({ assetsDir, metadata, releaseView })
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
    }
  }
}

export async function runReleaseReceiptsCli(argv) {
  const [command, ...rest] = argv
  const options = parseOptions(rest)
  const common = {
    assetsDir: options.required('--assets-dir'),
    packageJson: readPhysicalJson(options.required('--package-json'), 'package.json'),
    tag: options.required('--tag'),
    commit: options.required('--commit'),
    repository: options.required('--repository')
  }

  if (command === 'prepare') {
    const summary = prepareReleaseReceipts({
      ...common,
      teamId: options.required('--team-id'),
      runUrl: options.required('--run-url'),
      titleOut: options.required('--title-out'),
      bodyOut: options.required('--body-out')
    })
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  if (command === 'verify') {
    const summary = verifyReleaseReceipts({
      ...common,
      releaseView: readPhysicalJson(options.required('--release-view'), 'release view')
    })
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  throw new Error('Usage: release-receipts.mjs prepare|verify [options]')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await runReleaseReceiptsCli(process.argv.slice(2))
}
