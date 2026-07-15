/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

if (process.platform !== 'darwin') {
  throw new Error('macOS native-helper staging verification must run on macOS')
}

const electronArch = process.env.TARGET_ARCH?.trim() || process.arch
const minimumMacOSVersion = '13.0'
if (!['arm64', 'x64'].includes(electronArch)) {
  throw new Error('TARGET_ARCH must be arm64 or x64')
}
if (electronArch !== process.arch) {
  throw new Error(
    `cross-built native helpers are prohibited (${process.arch} runner, ${electronArch} target)`
  )
}

const machArch = electronArch === 'x64' ? 'x86_64' : 'arm64'
const resourceArch = machArch
if (
  process.env.JARVIS_MACOS_SPEECH_RESOURCE_ARCH &&
  process.env.JARVIS_MACOS_SPEECH_RESOURCE_ARCH !== resourceArch
) {
  throw new Error('staged native-helper resource architecture does not match the Electron target')
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000 })
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    throw new Error(
      `${basename(command)} ${args.join(' ')} failed${detail ? `:\n${detail.slice(-4000)}` : ''}`
    )
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function requirePhysicalDirectory(path, label) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a physical directory`)
  }
}

function assertExactEntries(directory, expected, label) {
  const actual = readdirSync(directory).sort()
  const normalizedExpected = [...expected].sort()
  if (actual.join('\n') !== normalizedExpected.join('\n')) {
    throw new Error(
      `${label} must contain exactly ${normalizedExpected.join(', ')}; found ${actual.join(', ') || 'none'}`
    )
  }
}

function entitlementKeys(path) {
  const xml = run('/usr/bin/codesign', ['--display', '--entitlements', ':-', path])
  return [...xml.matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1]).sort()
}

function verifyHelper(path, expectedEntitlements) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (info.mode & 0o111) === 0) {
    throw new Error(`${basename(path)} must be a single-link physical executable`)
  }

  const lipo = run('/usr/bin/lipo', ['-archs', path])
  const architectures = lipo.trim().split(/\s+/u).filter(Boolean)
  if (architectures.length !== 1 || architectures[0] !== machArch) {
    throw new Error(`${basename(path)} is ${architectures.join(', ')}, expected only ${machArch}`)
  }

  const buildVersion = run('/usr/bin/xcrun', ['vtool', '-show-build', path])
  const helperMinimumVersion = buildVersion.match(/\bminos\s+([0-9.]+)/u)?.[1]
  if (helperMinimumVersion !== minimumMacOSVersion) {
    throw new Error(
      `${basename(path)} targets macOS ${helperMinimumVersion ?? 'unknown'}, expected ${minimumMacOSVersion}`
    )
  }

  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', path])
  const signature = run('/usr/bin/codesign', ['--display', '--verbose=4', path])
  if (!/^Signature=adhoc$/mu.test(signature) || /^Authority=/mu.test(signature)) {
    throw new Error(`${basename(path)} staging signature must be ad-hoc`)
  }
  const actualEntitlements = entitlementKeys(path)
  if (actualEntitlements.join('\n') !== [...expectedEntitlements].sort().join('\n')) {
    throw new Error(
      `${basename(path)} entitlements must be exactly ${expectedEntitlements.join(', ') || 'empty'}; found ${actualEntitlements.join(', ') || 'empty'}`
    )
  }

  return {
    name: basename(path),
    path,
    bytes: info.size,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    signature: 'ad-hoc',
    entitlements: actualEntitlements
  }
}

const stageRoot = resolve('build', 'native', 'macos-speech')
const architectureRoot = join(stageRoot, resourceArch)
requirePhysicalDirectory(stageRoot, 'Native-helper stage root')
assertExactEntries(stageRoot, [resourceArch], 'Native-helper stage root')
requirePhysicalDirectory(architectureRoot, 'Native-helper architecture directory')
const expectedNames = ['jarvis-macos-speech', 'jarvis-workspace-helper']
assertExactEntries(architectureRoot, expectedNames, 'Native-helper architecture directory')

const helpers = [
  verifyHelper(join(architectureRoot, 'jarvis-macos-speech'), [
    'com.apple.security.device.audio-input'
  ]),
  verifyHelper(join(architectureRoot, 'jarvis-workspace-helper'), [])
]

console.log(
  JSON.stringify(
    {
      electronArch,
      resourceArch,
      machArch,
      minimumMacOSVersion,
      helpers
    },
    null,
    2
  )
)
