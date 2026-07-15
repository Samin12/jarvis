/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { verifyLegalNotices } from './legal-notices.mjs'
import { verifyMacOSEntitlementBoundaries } from './verify-macos-entitlements.mjs'
import {
  assertDeveloperIdSignature,
  requireAppleTeamId,
  sha256PhysicalFile
} from './release-policy.mjs'

const require = createRequire(import.meta.url)
const { listPackage } = require('@electron/asar')

const BUNDLE_IDENTIFIER = 'us.aianswer.jarvis'
const MINIMUM_MACOS_VERSION = '13.0'
const DEVELOPMENT_ENTRY_PATTERN =
  /^(?:tests|\.github|docs|legal|native|src|scripts)(?:\/|$)|^(?:vitest\.config\.ts|playwright\.config\.ts|tsconfig\.test\.json)$/
const SENSITIVE_PATH_PATTERN =
  /(?:^|\/)(?:\.codex|\.jarvis)(?:\/|$)|(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|auth\.json(?:\.[^/]*)?|credentials?\.json(?:\.[^/]*)?|electron-builder\.env|[^/]+\.(?:p12|p8|pem|key|jks|mobileprovision))(?:$)/i
const SECRET_PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
  ['JWT bearer token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/]
]
const MACH_O_MAGICS = new Set([
  'cafebabe',
  'cafebabf',
  'cefaedfe',
  'cffaedfe',
  'bebafeca',
  'bfbafeca',
  'feedface',
  'feedfacf'
])

function parseArgs(argv) {
  const parsed = {
    arch: process.arch,
    distDir: resolve('dist'),
    mode: 'release',
    summaryPath: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--arch') parsed.arch = argv[++index]
    else if (value === '--dist-dir') parsed.distDir = resolve(argv[++index])
    else if (value === '--mode') parsed.mode = argv[++index]
    else if (value === '--summary-path') parsed.summaryPath = resolve(argv[++index])
    else throw new Error(`Unknown argument: ${value}`)
  }
  if (!['arm64', 'x64'].includes(parsed.arch)) throw new Error('--arch must be arm64 or x64')
  if (!['development', 'release'].includes(parsed.mode)) {
    throw new Error('--mode must be development or release')
  }
  return parsed
}

function walk(root, predicate) {
  const matches = []
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (predicate(path, entry)) matches.push(path)
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(path)
    }
  }
  return matches.sort()
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
    ...options
  })
  if (result.error || result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(
      `${basename(command)} ${args.join(' ')} failed${detail ? `:\n${detail.slice(-4000)}` : ''}`
    )
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

function tryRun(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
    ...options
  })
}

function plistValue(plist, key) {
  return run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])
}

function assertExactArchitecture(binary, expected, label) {
  const architectures = run('/usr/bin/lipo', ['-archs', binary]).split(/\s+/).sort()
  if (architectures.length !== 1 || architectures[0] !== expected) {
    throw new Error(`${label} is ${architectures.join(', ')}, expected only ${expected}`)
  }
}

function assertMinimumDeploymentTarget(executablePath, label) {
  const buildVersion = run('/usr/bin/xcrun', ['vtool', '-show-build', executablePath])
  const minimum = buildVersion.match(/\bminos\s+([0-9.]+)/u)?.[1]
  if (minimum !== MINIMUM_MACOS_VERSION) {
    throw new Error(
      `${label} targets macOS ${minimum ?? 'unknown'}, expected ${MINIMUM_MACOS_VERSION}`
    )
  }
}

function assertExactPhysicalDirectory(directory, expectedNames, label) {
  const info = lstatSync(directory)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a physical directory`)
  }
  const actualNames = readdirSync(directory).sort()
  const expected = [...expectedNames].sort()
  if (actualNames.join('\n') !== expected.join('\n')) {
    throw new Error(
      `${label} must contain exactly ${expected.join(', ')}; found ${actualNames.join(', ') || 'none'}`
    )
  }
}

function assertSignature(path, mode, label, expectedTeamId = null) {
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', path])
  const signature = run('/usr/bin/codesign', ['--display', '--verbose=4', path])
  if (mode === 'release') {
    assertDeveloperIdSignature(signature, expectedTeamId, label)
  } else if (!/Signature=adhoc/.test(signature) || /Authority=Developer ID/.test(signature)) {
    throw new Error(`${label} must be ad-hoc signed in development mode`)
  }
  return signature
}

function isMachO(path) {
  const descriptor = openSync(path, 'r')
  try {
    const magic = Buffer.alloc(4)
    if (readSync(descriptor, magic, 0, magic.byteLength, 0) !== magic.byteLength) return false
    return MACH_O_MAGICS.has(magic.toString('hex'))
  } finally {
    closeSync(descriptor)
  }
}

function verifyAllMachOSignatures(appPath, mode, expectedTeamId, label) {
  const binaries = walk(
    appPath,
    (path, entry) => entry.isFile() && !entry.isSymbolicLink() && isMachO(path)
  )
  if (binaries.length === 0) throw new Error(`${label} contains no Mach-O binaries`)
  for (const binary of binaries) {
    assertSignature(
      binary,
      mode,
      `${label} ${relative(appPath, binary).replaceAll('\\', '/')}`,
      expectedTeamId
    )
  }
  return binaries.length
}

function assertSensitivePathAbsent(path, label) {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '')
  if (SENSITIVE_PATH_PATTERN.test(normalized)) {
    throw new Error(`${label} contains credential-bearing path: ${normalized}`)
  }
}

function hashAndScanFile(path, displayPath) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let carry = ''
  const fd = openSync(path, 'r')
  try {
    while (true) {
      const size = readSync(fd, buffer, 0, buffer.length, null)
      if (size === 0) break
      const chunk = buffer.subarray(0, size)
      hash.update(chunk)
      const text = `${carry}${chunk.toString('latin1')}`
      for (const [label, pattern] of SECRET_PATTERNS) {
        if (pattern.test(text)) {
          throw new Error(`Possible ${label} leaked into ${displayPath}`)
        }
      }
      carry = text.slice(-1024)
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function createBundleManifest(appPath, label) {
  const entries = walk(appPath, () => true)
  const manifest = []
  const rootPrefix = `${resolve(appPath)}${sep}`

  for (const path of entries) {
    const relativePath = relative(appPath, path).replaceAll('\\', '/')
    assertSensitivePathAbsent(relativePath, label)
    const info = lstatSync(path)
    if (info.isDirectory()) continue
    if (info.isSymbolicLink()) {
      const target = readlinkSync(path)
      const resolvedTarget = resolve(dirname(path), target)
      if (resolvedTarget !== resolve(appPath) && !resolvedTarget.startsWith(rootPrefix)) {
        throw new Error(`${label} contains a symlink escaping the app bundle: ${relativePath}`)
      }
      manifest.push(`link ${relativePath} ${target}`)
      continue
    }
    if (!info.isFile()) throw new Error(`${label} contains a special file: ${relativePath}`)
    const hash = hashAndScanFile(path, `${label}/${relativePath}`)
    manifest.push(`file ${(info.mode & 0o777).toString(8)} ${relativePath} ${hash}`)
  }

  return manifest.sort()
}

function findSingleTopLevelApp(root, label) {
  const apps = walk(root, (_path, entry) => entry.isDirectory() && entry.name.endsWith('.app'))
  const topLevelApps = apps.filter(
    (candidate) =>
      !apps.some((other) => other !== candidate && candidate.startsWith(`${other}${sep}`))
  )
  if (topLevelApps.length !== 1) {
    throw new Error(
      `${label} must contain exactly one top-level .app; found ${topLevelApps.length}`
    )
  }
  const appPath = topLevelApps[0]
  const info = lstatSync(appPath)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} app must be a physical directory`)
  }
  if (basename(appPath) !== 'Jarvis.app') {
    throw new Error(`${label} app must be named Jarvis.app`)
  }
  return appPath
}

function assertSafeZipEntries(zip) {
  const entries = run('/usr/bin/unzip', ['-Z1', zip], { timeout: 180_000 }).split(/\r?\n/)
  if (entries.length === 0 || entries.every((entry) => entry.length === 0)) {
    throw new Error(`${basename(zip)} is empty`)
  }
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/')
    const segments = normalized.split('/')
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:\//.test(normalized) ||
      segments.includes('..') ||
      normalized.includes('\0')
    ) {
      throw new Error(`${basename(zip)} contains an unsafe entry: ${entry}`)
    }
    assertSensitivePathAbsent(normalized, `${basename(zip)} archive`)
  }
}

function verifyOuterArtifactTree(root, appPath, label, strictSingleRootEntry) {
  if (strictSingleRootEntry) {
    const rootEntries = readdirSync(root)
    if (rootEntries.length !== 1 || join(root, rootEntries[0]) !== appPath) {
      throw new Error(`${label} archive root must contain only Jarvis.app`)
    }
  }

  const appPrefix = `${appPath}${sep}`
  for (const path of walk(root, () => true)) {
    const relativePath = relative(root, path).replaceAll('\\', '/')
    assertSensitivePathAbsent(relativePath, label)
    if (path === appPath || path.startsWith(appPrefix)) continue
    const info = lstatSync(path)
    if (info.isFile()) hashAndScanFile(path, `${label}/${relativePath}`)
  }
}

function verifyApp(appPath, label, context) {
  const { arch, codexVersion, expectedTeamId, machArch, mode, packageVersion, resourceArch } =
    context
  const plist = join(appPath, 'Contents', 'Info.plist')
  if (plistValue(plist, 'CFBundleIdentifier') !== BUNDLE_IDENTIFIER) {
    throw new Error(`${label} has an unexpected CFBundleIdentifier`)
  }
  if (plistValue(plist, 'CFBundleShortVersionString') !== packageVersion) {
    throw new Error(`${label} bundle version does not match package.json`)
  }
  if (plistValue(plist, 'CFBundleVersion') !== packageVersion) {
    throw new Error(`${label} build version does not match package.json`)
  }
  if (plistValue(plist, 'LSMinimumSystemVersion') !== MINIMUM_MACOS_VERSION) {
    throw new Error(`${label} LSMinimumSystemVersion must be ${MINIMUM_MACOS_VERSION}`)
  }
  if (!plistValue(plist, 'NSMicrophoneUsageDescription')) {
    throw new Error(`${label} is missing NSMicrophoneUsageDescription`)
  }
  if (!plistValue(plist, 'NSSpeechRecognitionUsageDescription')) {
    throw new Error(`${label} is missing NSSpeechRecognitionUsageDescription`)
  }

  const executableName = plistValue(plist, 'CFBundleExecutable')
  const executablePath = join(appPath, 'Contents', 'MacOS', executableName)
  const executableInfo = lstatSync(executablePath)
  if (
    executableInfo.isSymbolicLink() ||
    !executableInfo.isFile() ||
    (executableInfo.mode & 0o111) === 0
  ) {
    throw new Error(`${label} main executable is not a physical executable file`)
  }
  assertExactArchitecture(executablePath, machArch, `${label} main executable`)

  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath])
  const appSignature = assertSignature(appPath, mode, `${label} app`, expectedTeamId)
  if (mode === 'release') {
    if (!/flags=.*runtime/.test(appSignature)) {
      throw new Error(`${label} is missing the hardened runtime signature flag`)
    }
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
    run('/usr/bin/xcrun', ['stapler', 'validate', appPath])
  }

  const resources = join(appPath, 'Contents', 'Resources')
  const legalNotices = verifyLegalNotices(join(resources, 'legal'))
  const appAsar = join(resources, 'app.asar')
  const appAsarInfo = lstatSync(appAsar)
  if (appAsarInfo.isSymbolicLink() || !appAsarInfo.isFile()) {
    throw new Error(`${label} app.asar must be a physical file`)
  }
  const asarEntries = listPackage(appAsar).map((entry) =>
    entry.replaceAll('\\', '/').replace(/^\/+/, '')
  )
  const developmentEntries = asarEntries.filter((entry) => DEVELOPMENT_ENTRY_PATTERN.test(entry))
  if (developmentEntries.length > 0) {
    throw new Error(
      `${label} app.asar contains development-only files: ${developmentEntries.slice(0, 20).join(', ')}`
    )
  }
  for (const entry of asarEntries) assertSensitivePathAbsent(entry, `${label} app.asar`)

  const speechRoot = join(resources, 'native', 'macos-speech')
  const speechHelper = join(speechRoot, resourceArch, 'jarvis-macos-speech')
  const workspaceHelper = join(speechRoot, resourceArch, 'jarvis-workspace-helper')
  const expectedNativeHelpers = [speechHelper, workspaceHelper].sort()
  assertExactPhysicalDirectory(speechRoot, [resourceArch], `${label} native-helper resource root`)
  assertExactPhysicalDirectory(
    join(speechRoot, resourceArch),
    expectedNativeHelpers.map((helper) => basename(helper)),
    `${label} native-helper architecture directory`
  )
  const helperEvidence = []
  for (const helper of expectedNativeHelpers) {
    const helperInfo = lstatSync(helper)
    if (
      helperInfo.isSymbolicLink() ||
      !helperInfo.isFile() ||
      helperInfo.nlink !== 1 ||
      (helperInfo.mode & 0o111) === 0
    ) {
      throw new Error(`${label} ${basename(helper)} is not a single-link physical executable`)
    }
    assertExactArchitecture(helper, machArch, `${label} ${basename(helper)}`)
    assertMinimumDeploymentTarget(helper, `${label} ${basename(helper)}`)
    assertSignature(helper, mode, `${label} ${basename(helper)}`, expectedTeamId)
    helperEvidence.push({
      name: `${resourceArch}/${basename(helper)}`,
      ...sha256PhysicalFile(helper)
    })
  }

  const unpacked = join(resources, 'app.asar.unpacked')
  const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  const codexCandidates = walk(
    unpacked,
    (path, entry) => entry.isFile() && entry.name === 'codex' && path.includes(triple)
  )
  if (codexCandidates.length !== 1) {
    throw new Error(
      `${label} expected one unpacked ${triple} Codex binary; found ${codexCandidates.length}`
    )
  }
  const codexBinary = codexCandidates[0]
  assertExactArchitecture(codexBinary, machArch, `${label} bundled Codex`)
  const reportedCodexVersion = run(codexBinary, ['--version'])
  if (!reportedCodexVersion.includes(codexVersion)) {
    throw new Error(
      `${label} bundled Codex reports ${reportedCodexVersion}; expected ${codexVersion}`
    )
  }
  assertSignature(codexBinary, mode, `${label} bundled Codex`, expectedTeamId)

  const entitlementSummary = verifyMacOSEntitlementBoundaries(appPath)
  const signedMachOCount = verifyAllMachOSignatures(appPath, mode, expectedTeamId, `${label} app`)
  const manifest = createBundleManifest(appPath, label)
  return {
    appPath,
    codex: reportedCodexVersion,
    executablePath,
    entitlementSummary,
    manifest,
    manifestSha256: createHash('sha256').update(manifest.join('\n')).digest('hex'),
    signedMachOCount,
    legalNotices,
    helpers: helperEvidence,
    speechHelper: `${resourceArch}/jarvis-macos-speech`,
    workspaceHelper: `${resourceArch}/jarvis-workspace-helper`
  }
}

function attachDmg(dmg, mountPath) {
  mkdirSync(mountPath, { recursive: true })
  run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPath, dmg], {
    timeout: 180_000
  })
}

function detachDmg(mountPath) {
  const normal = tryRun('/usr/bin/hdiutil', ['detach', mountPath], { timeout: 60_000 })
  if (!normal.error && normal.status === 0) return
  run('/usr/bin/hdiutil', ['detach', '-force', mountPath], { timeout: 60_000 })
}

function prepareCopiedInstall(sourceApp, label, installRoot, mode) {
  const destinationRoot = join(installRoot, label.toLowerCase())
  const destinationApp = join(destinationRoot, 'Jarvis.app')
  mkdirSync(destinationRoot, { recursive: true })
  run('/usr/bin/ditto', [sourceApp, destinationApp], { timeout: 180_000 })

  const destinationInfo = lstatSync(destinationApp)
  if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
    throw new Error(`${label} copied install is not a physical Jarvis.app bundle`)
  }

  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', destinationApp])
  if (mode === 'release') {
    const quarantine = `0081;${Math.floor(Date.now() / 1000).toString(16)};JarvisReleaseVerification;${randomUUID()}`
    run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantine, destinationApp])
    const storedQuarantine = run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', destinationApp])
    if (storedQuarantine !== quarantine) {
      throw new Error(`${label} copied install did not retain its quarantine marker`)
    }
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', destinationApp])
    run('/usr/bin/xcrun', ['stapler', 'validate', destinationApp])
  }

  const plist = join(destinationApp, 'Contents', 'Info.plist')
  const executable = join(
    destinationApp,
    'Contents',
    'MacOS',
    plistValue(plist, 'CFBundleExecutable')
  )
  return { appPath: destinationApp, executablePath: executable, label: `${label} copied install` }
}

function runPackagedSmoke(targets, outputRoot) {
  const playwright = resolve(
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'playwright.cmd' : 'playwright'
  )
  if (!existsSync(playwright)) {
    throw new Error('Playwright is required for packaged app smoke verification')
  }

  const smokeHome = join(outputRoot, 'home')
  const smokeOutput = join(outputRoot, 'playwright')
  mkdirSync(smokeHome, { recursive: true })
  mkdirSync(smokeOutput, { recursive: true })
  run(
    playwright,
    ['test', 'tests/e2e/packaged.smoke.spec.ts', '--config', 'playwright.config.ts'],
    {
      timeout: 240_000,
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: smokeHome,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        CI: process.env.CI ?? '',
        JARVIS_PACKAGED_APP_TARGETS: JSON.stringify(targets),
        JARVIS_PLAYWRIGHT_OUTPUT_DIR: smokeOutput
      }
    }
  )
}

if (process.platform !== 'darwin') {
  throw new Error('Packaged macOS verification must run on macOS')
}

const { arch, distDir, mode, summaryPath } = parseArgs(process.argv.slice(2))
const machArch = arch === 'x64' ? 'x86_64' : 'arm64'
const resourceArch = machArch
const expectedTeamId = mode === 'release' ? requireAppleTeamId(process.env.APPLE_TEAM_ID) : null
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
const codexPkg = JSON.parse(
  readFileSync(resolve('node_modules/@openai/codex/package.json'), 'utf8')
)
const expectedZip = join(
  distDir,
  mode === 'release'
    ? `${pkg.name}-${pkg.version}-${arch}.zip`
    : `Jarvis-${pkg.version}-${arch}-mac.zip`
)
const expectedDmg = join(distDir, `${pkg.name}-${pkg.version}-${arch}.dmg`)
for (const artifact of [expectedZip, expectedDmg]) {
  if (!existsSync(artifact) || !statSync(artifact).isFile()) {
    throw new Error(`Missing expected ${basename(artifact)} artifact in ${distDir}`)
  }
}
const artifactEvidence = [expectedDmg, expectedZip]
  .map((artifact) => ({ name: basename(artifact), ...sha256PhysicalFile(artifact) }))
  .sort((left, right) => left.name.localeCompare(right.name))

run('/usr/bin/hdiutil', ['verify', expectedDmg], { timeout: 180_000 })
assertSafeZipEntries(expectedZip)

const workRoot = mkdtempSync(join(tmpdir(), `jarvis-package-${arch}-`))
const extractRoot = join(workRoot, 'zip')
const mountRoot = join(workRoot, 'dmg')
const installRoot = join(workRoot, 'installed')
const smokeRoot = join(workRoot, 'smoke')
let dmgMounted = false
let verificationError = null

try {
  mkdirSync(extractRoot, { recursive: true })
  run('/usr/bin/ditto', ['-x', '-k', expectedZip, extractRoot], { timeout: 180_000 })
  const zipApp = findSingleTopLevelApp(extractRoot, 'ZIP')
  verifyOuterArtifactTree(extractRoot, zipApp, 'ZIP', true)
  const context = {
    arch,
    codexVersion: codexPkg.version,
    expectedTeamId,
    machArch,
    mode,
    packageVersion: pkg.version,
    resourceArch
  }
  const zipResult = verifyApp(zipApp, 'ZIP', context)

  attachDmg(expectedDmg, mountRoot)
  dmgMounted = true
  const dmgApp = findSingleTopLevelApp(mountRoot, 'DMG')
  verifyOuterArtifactTree(mountRoot, dmgApp, 'DMG', false)
  const dmgResult = verifyApp(dmgApp, 'DMG', context)

  if (zipResult.manifestSha256 !== dmgResult.manifestSha256) {
    const zipEntries = new Set(zipResult.manifest)
    const dmgEntries = new Set(dmgResult.manifest)
    const differences = [
      ...zipResult.manifest
        .filter((entry) => !dmgEntries.has(entry))
        .map((entry) => `ZIP: ${entry}`),
      ...dmgResult.manifest
        .filter((entry) => !zipEntries.has(entry))
        .map((entry) => `DMG: ${entry}`)
    ]
    throw new Error(
      `ZIP and DMG contain different app bundles:\n${differences.slice(0, 20).join('\n')}`
    )
  }

  const copiedTargets = [
    prepareCopiedInstall(zipResult.appPath, 'ZIP', installRoot, mode),
    prepareCopiedInstall(dmgResult.appPath, 'DMG', installRoot, mode)
  ]
  runPackagedSmoke(copiedTargets, smokeRoot)

  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', zipResult.appPath])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', dmgResult.appPath])

  const summary = {
    schemaVersion: 1,
    package: `Jarvis ${pkg.version}`,
    packageVersion: pkg.version,
    arch,
    mode,
    teamId: expectedTeamId,
    artifacts: artifactEvidence,
    bundleParity: zipResult.manifestSha256,
    signedMachOCount: zipResult.signedMachOCount,
    checks: [
      'ZIP bundle verified',
      'DMG bundle verified',
      'bundle contents identical',
      'credential scan clean',
      'third-party legal notices verified',
      'main/helper entitlement boundaries verified',
      'every nested Mach-O signature verified',
      'both copied installs opened signed-out onboarding'
    ],
    signature: mode === 'release' ? 'Developer ID + hardened runtime' : 'ad-hoc (development only)',
    notarization: mode === 'release' ? 'Gatekeeper accepted + stapled ticket' : 'not required',
    copiedInstall:
      mode === 'release'
        ? 'quarantined copies passed Gatekeeper and onboarding smoke'
        : 'copied development installs passed onboarding smoke',
    speechHelper: zipResult.speechHelper,
    nativeHelpers: zipResult.helpers,
    legalNotices: zipResult.legalNotices,
    codex: zipResult.codex
  }
  if (summaryPath) {
    mkdirSync(dirname(summaryPath), { recursive: true })
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
  }
  console.log(JSON.stringify(summary, null, 2))
} catch (error) {
  verificationError = error
} finally {
  if (dmgMounted) {
    try {
      detachDmg(mountRoot)
    } catch (error) {
      if (!verificationError) verificationError = error
      else
        console.error(`DMG detach also failed: ${error instanceof Error ? error.message : error}`)
    }
  }
  rmSync(workRoot, { recursive: true, force: true })
}

if (verificationError) throw verificationError
