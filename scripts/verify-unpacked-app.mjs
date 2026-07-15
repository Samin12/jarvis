/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyLegalNotices } from './legal-notices.mjs'
import { verifyMacOSEntitlementBoundaries } from './verify-macos-entitlements.mjs'

const require = createRequire(import.meta.url)
const { listPackage } = require('@electron/asar')
const MINIMUM_MACOS_VERSION = '13.0'

function parseArgs(argv) {
  const parsed = { arch: process.arch, appPath: null, distDir: resolve('dist') }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--arch') parsed.arch = argv[++index]
    else if (value === '--app') parsed.appPath = resolve(argv[++index])
    else if (value === '--dist-dir') parsed.distDir = resolve(argv[++index])
    else throw new Error(`Unknown argument: ${value}`)
  }
  if (!['arm64', 'x64'].includes(parsed.arch)) throw new Error('--arch must be arm64 or x64')
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
  return matches
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

function plistValue(plist, key) {
  return run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])
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

function assertMinimumDeploymentTarget(executablePath, label) {
  const buildVersion = run('/usr/bin/xcrun', ['vtool', '-show-build', executablePath])
  const minimum = buildVersion.match(/\bminos\s+([0-9.]+)/u)?.[1]
  if (minimum !== MINIMUM_MACOS_VERSION) {
    throw new Error(
      `${label} targets macOS ${minimum ?? 'unknown'}, expected ${MINIMUM_MACOS_VERSION}`
    )
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

if (process.platform !== 'darwin') throw new Error('macOS package verification requires macOS')

const { arch, appPath: requestedApp, distDir } = parseArgs(process.argv.slice(2))
const machArch = arch === 'x64' ? 'x86_64' : 'arm64'
const resourceArch = machArch
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
const codexPkg = JSON.parse(
  readFileSync(resolve('node_modules/@openai/codex/package.json'), 'utf8')
)

let appPath = requestedApp
if (!appPath) {
  const apps = walk(distDir, (_path, entry) => entry.isDirectory() && entry.name === 'Jarvis.app')
  const topLevelApps = apps.filter(
    (candidate) => !apps.some((other) => other !== candidate && candidate.startsWith(`${other}/`))
  )
  if (topLevelApps.length !== 1) {
    throw new Error(`Expected one unpacked Jarvis.app in ${distDir}, found ${topLevelApps.length}`)
  }
  appPath = topLevelApps[0]
}

const plist = join(appPath, 'Contents', 'Info.plist')
if (plistValue(plist, 'CFBundleIdentifier') !== 'us.aianswer.jarvis') {
  throw new Error('Unexpected CFBundleIdentifier')
}
if (plistValue(plist, 'CFBundleShortVersionString') !== pkg.version) {
  throw new Error('Bundle version does not match package.json')
}
if (plistValue(plist, 'LSMinimumSystemVersion') !== MINIMUM_MACOS_VERSION) {
  throw new Error(`LSMinimumSystemVersion must be ${MINIMUM_MACOS_VERSION}`)
}
if (!plistValue(plist, 'NSMicrophoneUsageDescription')) {
  throw new Error('NSMicrophoneUsageDescription is missing')
}
if (!plistValue(plist, 'NSSpeechRecognitionUsageDescription')) {
  throw new Error('NSSpeechRecognitionUsageDescription is missing')
}

const executableName = plistValue(plist, 'CFBundleExecutable')
const executable = join(appPath, 'Contents', 'MacOS', executableName)
const appArchitectures = run('/usr/bin/lipo', ['-archs', executable]).split(/\s+/)
if (!appArchitectures.includes(machArch)) {
  throw new Error(`Main executable is ${appArchitectures.join(', ')}, expected ${machArch}`)
}

const resources = join(appPath, 'Contents', 'Resources')
const legalNotices = verifyLegalNotices(join(resources, 'legal'))
const appAsar = join(resources, 'app.asar')
if (!statSync(appAsar).isFile()) throw new Error('app.asar is missing')
const forbiddenAsarEntries = listPackage(appAsar)
  .map((entry) => entry.replaceAll('\\', '/').replace(/^\/+/, ''))
  .filter((entry) =>
    /^(?:tests|\.github|docs|legal|native|src|scripts)(?:\/|$)|^(?:vitest\.config\.ts|playwright\.config\.ts|tsconfig\.test\.json)$|(?:^|\/)(?:\.jarvis(?:\/|$)|auth\.json$|electron-builder\.env$|\.env(?:\.|$)|\.npmrc$|[^/]+\.(?:p12|pfx|p8|cer|pem|key|mobileprovision|jks)$)/i.test(
      entry
    )
  )
if (forbiddenAsarEntries.length > 0) {
  throw new Error(
    `Development-only or credential-bearing files leaked into app.asar: ${forbiddenAsarEntries.slice(0, 20).join(', ')}`
  )
}

const speechRoot = join(resources, 'native', 'macos-speech')
const speechHelper = join(speechRoot, resourceArch, 'jarvis-macos-speech')
const workspaceHelper = join(speechRoot, resourceArch, 'jarvis-workspace-helper')
const expectedNativeHelpers = [speechHelper, workspaceHelper].sort()
assertExactPhysicalDirectory(speechRoot, [resourceArch], 'Native-helper resource root')
assertExactPhysicalDirectory(
  join(speechRoot, resourceArch),
  expectedNativeHelpers.map((helper) => basename(helper)),
  'Native-helper architecture directory'
)
for (const helper of expectedNativeHelpers) {
  const helperInfo = lstatSync(helper)
  if (
    helperInfo.isSymbolicLink() ||
    !helperInfo.isFile() ||
    helperInfo.nlink !== 1 ||
    (helperInfo.mode & 0o111) === 0
  ) {
    throw new Error(`${basename(helper)} is not a single-link physical executable`)
  }
  const architectures = run('/usr/bin/lipo', ['-archs', helper]).split(/\s+/)
  if (architectures.length !== 1 || architectures[0] !== machArch) {
    throw new Error(`${basename(helper)} is ${architectures.join(', ')}, expected only ${machArch}`)
  }
  assertMinimumDeploymentTarget(helper, basename(helper))
}

const unpacked = join(resources, 'app.asar.unpacked')
const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
const codexCandidates = walk(
  unpacked,
  (path, entry) => entry.isFile() && entry.name === 'codex' && path.includes(triple)
)
if (codexCandidates.length !== 1) {
  throw new Error(`Expected one unpacked ${triple} Codex binary, found ${codexCandidates.length}`)
}
const codexBinary = codexCandidates[0]
const codexArchitectures = run('/usr/bin/lipo', ['-archs', codexBinary]).split(/\s+/)
if (!codexArchitectures.includes(machArch)) {
  throw new Error(`Bundled Codex is ${codexArchitectures.join(', ')}, expected ${machArch}`)
}
const codexVersion = run(codexBinary, ['--version'])
if (!codexVersion.includes(codexPkg.version)) {
  throw new Error(`Bundled Codex reports ${codexVersion}; expected ${codexPkg.version}`)
}

run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', speechHelper])
run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', workspaceHelper])
run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', codexBinary])
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath])
const entitlementSummary = verifyMacOSEntitlementBoundaries(appPath)
const signature = run('/usr/bin/codesign', ['--display', '--verbose=4', appPath])
if (!/Signature=adhoc/.test(signature) || /Authority=Developer ID/.test(signature)) {
  throw new Error('Development package must be ad-hoc signed, never Developer ID signed')
}

const summary = {
  package: `Jarvis ${pkg.version}`,
  arch,
  app: appPath,
  signature: 'ad-hoc (development only)',
  helpers: expectedNativeHelpers.map((helper) => ({
    name: `${resourceArch}/${basename(helper)}`,
    bytes: statSync(helper).size,
    sha256: sha256(helper)
  })),
  entitlementSummary,
  legalNotices,
  codex: codexVersion,
  asarLeakCount: forbiddenAsarEntries.length
}
const cacheDirectory = resolve('node_modules/.cache')
mkdirSync(cacheDirectory, { recursive: true })
writeFileSync(
  join(cacheDirectory, 'jarvis-dev-package-summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  'utf8'
)
console.log(JSON.stringify(summary, null, 2))
