#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAIN_EXACT_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.device.audio-input'
]
const SPEECH_EXACT_ENTITLEMENTS = ['com.apple.security.device.audio-input']
const MINIMUM_MACOS_VERSION = '13.0'
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

function normalizedRelativePath(root, candidate) {
  return relative(resolve(root), resolve(candidate)).replaceAll('\\', '/')
}

export function classifyNativeEntitlements(appPath, candidate) {
  const path = normalizedRelativePath(appPath, candidate)
  if (path.startsWith('../') || path === '..') return null
  if (
    /^Contents\/Resources\/native\/macos-speech\/(?:arm64|x86_64)\/jarvis-macos-speech$/u.test(path)
  ) {
    return 'speech'
  }
  if (
    /^Contents\/Resources\/native\/macos-speech\/(?:arm64|x86_64)\/jarvis-workspace-helper$/u.test(
      path
    ) ||
    /^Contents\/Resources\/app\.asar\.unpacked\/node_modules\/@openai\/codex(?:\/|-(?:darwin|linux|win32)-)/u.test(
      path
    )
  ) {
    return 'tool'
  }
  return null
}

export function isRestrictedNativeToolPath(appPath, candidate) {
  return classifyNativeEntitlements(appPath, candidate) !== null
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 60_000
  })
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    throw new Error(
      `${basename(command)} ${args.join(' ')} failed${detail ? `:\n${detail.slice(-4000)}` : ''}`
    )
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function plistValue(plist, key) {
  return run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]).trim()
}

function walkPhysicalFiles(root) {
  const files = []
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.pop()
    const currentInfo = lstatSync(current)
    if (currentInfo.isSymbolicLink()) {
      throw new Error(`Native tool path must not contain symlinks: ${current}`)
    }
    if (currentInfo.isFile()) {
      files.push(current)
      continue
    }
    if (!currentInfo.isDirectory()) {
      throw new Error(`Native tool path must contain only directories and files: ${current}`)
    }
    for (const entry of readdirSync(current)) queue.push(join(current, entry))
  }
  return files
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

function entitlements(path) {
  const xml = run('/usr/bin/codesign', ['--display', '--entitlements', ':-', path])
  return {
    keys: new Set([...xml.matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1])),
    xml
  }
}

function hasTrueEntitlement(xml, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`<key>${escapedKey}</key>\\s*<true\\s*/>`, 'u').test(xml)
}

function verifyExactEntitlements(path, expectedKeys, label) {
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', path])
  const { keys, xml } = entitlements(path)
  const actual = [...keys].sort()
  const expected = [...expectedKeys].sort()
  if (
    actual.join('\n') !== expected.join('\n') ||
    expected.some((key) => !hasTrueEntitlement(xml, key))
  ) {
    throw new Error(
      `${label} entitlements must be exactly ${expected.join(', ') || 'empty'}; found ${actual.join(', ') || 'empty'}`
    )
  }
  return actual
}

function requirePhysicalDirectory(path, label) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a physical directory`)
  }
}

function exactNativeHelperPaths(speechRoot) {
  requirePhysicalDirectory(speechRoot, 'Native helper root')
  const architectureEntries = readdirSync(speechRoot).sort()
  if (
    architectureEntries.length !== 1 ||
    !/^(?:arm64|x86_64)$/u.test(architectureEntries[0] ?? '')
  ) {
    throw new Error(
      `Native helper root must contain exactly one architecture directory; found ${architectureEntries.join(', ') || 'none'}`
    )
  }
  const architectureRoot = join(speechRoot, architectureEntries[0])
  requirePhysicalDirectory(architectureRoot, 'Native helper architecture directory')
  const expectedNames = ['jarvis-macos-speech', 'jarvis-workspace-helper']
  const actualNames = readdirSync(architectureRoot).sort()
  if (actualNames.join('\n') !== expectedNames.join('\n')) {
    throw new Error(
      `Native helper directory must contain exactly ${expectedNames.join(', ')}; found ${actualNames.join(', ') || 'none'}`
    )
  }
  return expectedNames.map((name) => {
    const path = join(architectureRoot, name)
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o111) === 0) {
      throw new Error(`${name} must be a physical executable file`)
    }
    return path
  })
}

export function verifyMacOSEntitlementBoundaries(requestedAppPath) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS entitlement verification must run on macOS')
  }
  const unresolvedAppPath = resolve(requestedAppPath)
  const requestedInfo = lstatSync(unresolvedAppPath)
  if (requestedInfo.isSymbolicLink()) throw new Error('The macOS .app path must not be a symlink')
  const appPath = realpathSync(unresolvedAppPath)
  if (!requestedInfo.isDirectory() || !appPath.endsWith('.app')) {
    throw new Error('Expected a physical macOS .app bundle')
  }
  const plist = join(appPath, 'Contents', 'Info.plist')
  if (plistValue(plist, 'LSMinimumSystemVersion') !== MINIMUM_MACOS_VERSION) {
    throw new Error(`LSMinimumSystemVersion must be ${MINIMUM_MACOS_VERSION}`)
  }

  const mainEntitlements = verifyExactEntitlements(appPath, MAIN_EXACT_ENTITLEMENTS, 'Main app')

  const resources = join(appPath, 'Contents', 'Resources')
  const speechRoot = join(resources, 'native', 'macos-speech')
  const openaiRoot = join(resources, 'app.asar.unpacked', 'node_modules', '@openai')
  const speechTools = exactNativeHelperPaths(speechRoot)
  if (speechTools.some((path) => !isMachO(path))) {
    throw new Error('Both native helpers must be Mach-O executables')
  }
  const codexTools = walkPhysicalFiles(openaiRoot).filter(
    (path) => isRestrictedNativeToolPath(appPath, path) && isMachO(path)
  )

  const codexExecutables = codexTools.filter((path) => basename(path) === 'codex')
  if (codexExecutables.length !== 1) {
    throw new Error(`Expected one native Codex executable, found ${codexExecutables.length}`)
  }

  const speechHelper = speechTools.find((path) => basename(path) === 'jarvis-macos-speech')
  const workspaceHelper = speechTools.find((path) => basename(path) === 'jarvis-workspace-helper')
  if (!speechHelper || !workspaceHelper) throw new Error('Native helper classification failed')
  verifyExactEntitlements(speechHelper, SPEECH_EXACT_ENTITLEMENTS, 'jarvis-macos-speech')
  verifyExactEntitlements(workspaceHelper, [], 'jarvis-workspace-helper')
  for (const path of codexTools) verifyExactEntitlements(path, [], `Codex tool ${basename(path)}`)
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath])

  return {
    app: appPath,
    mainEntitlements,
    speechEntitlements: SPEECH_EXACT_ENTITLEMENTS,
    workspaceEntitlements: [],
    codexEntitlements: [],
    speechTools: speechTools.map((path) => normalizedRelativePath(appPath, path)).sort(),
    codexTools: codexTools.map((path) => normalizedRelativePath(appPath, path)).sort()
  }
}

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== '--app' || !argv[1]) {
    throw new Error('Usage: node scripts/verify-macos-entitlements.mjs --app /path/to/Jarvis.app')
  }
  return argv[1]
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : null
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  const summary = verifyMacOSEntitlementBoundaries(parseCli(process.argv.slice(2)))
  console.log(JSON.stringify(summary, null, 2))
}
