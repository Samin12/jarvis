import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import {
  requireAppleApiIssuer,
  requireAppleApiKeyId,
  requireAppleTeamId
} from './release-policy.mjs'

const require = createRequire(import.meta.url)
const { getConfig } = require('app-builder-lib/out/util/config/config')
const { computeArchToTargetNamesMap } = require('app-builder-lib/out/targets/targetFactory')
const { Arch, Platform } = require('app-builder-lib')

const supportedArgs = new Set(['--config-only'])
const unknownArgs = process.argv.slice(2).filter((arg) => !supportedArgs.has(arg))
const configOnly = process.argv.includes('--config-only')
const errors = unknownArgs.map((arg) => `unknown argument: ${arg}`)

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
const expectedTag = `v${pkg.version}`
const expectedMinimumMacOSVersion = '13.0'
const targetArch = process.env.TARGET_ARCH?.trim() || (configOnly ? process.arch : '')
const expectedSwiftArch = targetArch === 'x64' ? 'x86_64' : targetArch
const expectedResourceArch = expectedSwiftArch
const swiftArch =
  process.env.JARVIS_MACOS_SPEECH_ARCH?.trim() || (configOnly ? expectedSwiftArch : '')
const resourceArch =
  process.env.JARVIS_MACOS_SPEECH_RESOURCE_ARCH?.trim() || (configOnly ? expectedResourceArch : '')
const releaseTag = process.env.RELEASE_TAG?.trim() || (configOnly ? expectedTag : '')

if (!configOnly) {
  const requiredSecrets = [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'APPLE_TEAM_ID'
  ]
  const placeholder = /^(?:change[-_ ]?me|placeholder|example|todo|none|null)$/i
  for (const name of requiredSecrets) {
    const value = process.env[name]?.trim() ?? ''
    if (!value) errors.push(`${name} is missing`)
    else if (placeholder.test(value)) errors.push(`${name} still contains a placeholder`)
  }

  for (const retiredName of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD']) {
    if (process.env[retiredName]?.trim()) {
      errors.push(
        `${retiredName} must not be used; trusted releases require an App Store Connect API key`
      )
    }
  }
  if (process.env.APPLE_API_KEY_BASE64?.trim()) {
    errors.push('APPLE_API_KEY_BASE64 must not remain after the private key is materialized')
  }
}

if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
  errors.push('CSC_IDENTITY_AUTO_DISCOVERY must not be disabled for a trusted macOS release')
}

const teamId = process.env.APPLE_TEAM_ID?.trim() ?? ''
if (!configOnly && teamId) {
  try {
    requireAppleTeamId(teamId)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
}
if (!configOnly && process.env.APPLE_API_KEY_ID?.trim()) {
  try {
    requireAppleApiKeyId(process.env.APPLE_API_KEY_ID)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
}
if (!configOnly && process.env.APPLE_API_ISSUER?.trim()) {
  try {
    requireAppleApiIssuer(process.env.APPLE_API_ISSUER)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
}

const apiKeyPath = process.env.APPLE_API_KEY?.trim() ?? ''
if (!configOnly && apiKeyPath) {
  try {
    const resolvedKeyPath = resolve(apiKeyPath)
    const before = lstatSync(resolvedKeyPath)
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      throw new Error('APPLE_API_KEY must point to a single-link physical file')
    }
    if ((before.mode & 0o077) !== 0) {
      throw new Error('APPLE_API_KEY must be readable only by the runner user (mode 0600)')
    }
    if (before.size < 100 || before.size > 16 * 1024) {
      throw new Error('APPLE_API_KEY has an invalid private-key size')
    }

    const descriptor = openSync(resolvedKeyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = fstatSync(descriptor)
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
        throw new Error('APPLE_API_KEY changed while it was opened')
      }
    } finally {
      closeSync(descriptor)
    }

    const pem = readFileSync(resolvedKeyPath, 'utf8').trim()
    if (
      !pem.startsWith('-----BEGIN PRIVATE KEY-----\n') ||
      !pem.endsWith('\n-----END PRIVATE KEY-----')
    ) {
      throw new Error('APPLE_API_KEY must contain one PKCS#8 PEM private key')
    }
  } catch (error) {
    errors.push(
      `APPLE_API_KEY is not a safe materialized key file: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

if (process.platform !== 'darwin') {
  errors.push(`trusted macOS release verification must run on macOS, not ${process.platform}`)
}
if (!['arm64', 'x64'].includes(targetArch)) {
  errors.push('TARGET_ARCH must be exactly arm64 or x64')
} else if (process.arch !== targetArch) {
  errors.push(`native release runner is ${process.arch}, but TARGET_ARCH is ${targetArch}`)
}
if (swiftArch !== expectedSwiftArch) {
  errors.push(`JARVIS_MACOS_SPEECH_ARCH must be ${expectedSwiftArch} for ${targetArch}`)
}
if (resourceArch !== expectedResourceArch) {
  errors.push(`JARVIS_MACOS_SPEECH_RESOURCE_ARCH must be ${expectedResourceArch} for ${targetArch}`)
}
if (releaseTag !== expectedTag) {
  errors.push(`RELEASE_TAG must be ${expectedTag} for package version ${pkg.version}`)
}

const baseConfigPath = resolve('electron-builder.yml')
const releaseConfigPath = resolve(
  process.env.JARVIS_RELEASE_CONFIG ?? 'electron-builder.release.yml'
)
if (!existsSync(baseConfigPath)) {
  errors.push(`development builder config is missing: ${baseConfigPath}`)
}
if (!existsSync(releaseConfigPath)) {
  errors.push(`trusted release config is missing: ${releaseConfigPath}`)
}

if (existsSync(baseConfigPath)) {
  const policy = readFileSync(baseConfigPath, 'utf8')
  const requiredDevelopmentPolicy = [
    ["identity: '-'", 'development ad-hoc identity'],
    [
      `minimumSystemVersion: '${expectedMinimumMacOSVersion}'`,
      `development macOS ${expectedMinimumMacOSVersion} deployment floor`
    ],
    ['hardenedRuntime: false', 'development hardenedRuntime: false'],
    ['notarize: false', 'development notarize: false'],
    [
      'from: build/native/macos-speech/${env.JARVIS_MACOS_SPEECH_RESOURCE_ARCH}/jarvis-macos-speech',
      'architecture-scoped native speech source'
    ],
    [
      'to: native/macos-speech/${env.JARVIS_MACOS_SPEECH_RESOURCE_ARCH}/jarvis-macos-speech',
      'architecture-scoped native speech destination'
    ],
    [
      'Contents/Resources/native/macos-speech/${env.JARVIS_MACOS_SPEECH_RESOURCE_ARCH}/jarvis-macos-speech',
      'native speech nested-signing path'
    ],
    ["- '!tests/**/*'", 'test exclusion'],
    ["- '!.github/**/*'", 'GitHub workflow exclusion'],
    ["- '!native/**/*'", 'native source exclusion'],
    ["- '!scripts/**/*'", 'non-runtime script exclusion'],
    ["- '!{vitest.config.ts,playwright.config.ts}'", 'test-runner config exclusion'],
    [
      "- '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json,tsconfig.test.json}'",
      'TypeScript config exclusion'
    ]
  ]
  for (const [snippet, description] of requiredDevelopmentPolicy) {
    if (!policy.includes(snippet))
      errors.push(`development builder config must declare ${description}`)
  }
}

if (existsSync(releaseConfigPath)) {
  const policy = readFileSync(releaseConfigPath, 'utf8')
  if (!/^extends:\s*electron-builder\.yml\s*$/m.test(policy)) {
    errors.push('trusted release config must declare extends: electron-builder.yml')
  }

  try {
    process.env.JARVIS_MACOS_SPEECH_RESOURCE_ARCH ||= process.arch === 'x64' ? 'x86_64' : 'arm64'
    const config = await getConfig(process.cwd(), releaseConfigPath, null)
    const mac = config.mac ?? {}
    const expectedArtifactName = '${name}-${version}-${arch}.${ext}'

    const requiredEffectiveValues = [
      [mac.identity, 'Developer ID Application', 'a Developer ID Application identity'],
      [mac.forceCodeSigning, true, 'forceCodeSigning: true'],
      [mac.hardenedRuntime, true, 'hardenedRuntime: true'],
      [mac.gatekeeperAssess, true, 'gatekeeperAssess: true'],
      [mac.notarize, true, 'notarize: true'],
      [
        mac.minimumSystemVersion,
        expectedMinimumMacOSVersion,
        `minimumSystemVersion: ${expectedMinimumMacOSVersion}`
      ],
      [config.artifactName, expectedArtifactName, `artifactName: ${expectedArtifactName}`],
      [config.dmg?.artifactName, expectedArtifactName, `DMG artifactName: ${expectedArtifactName}`]
    ]
    for (const [actual, expected, description] of requiredEffectiveValues) {
      if (actual !== expected) {
        errors.push(`effective trusted release config must declare ${description}`)
      }
    }

    for (const usageKey of [
      'NSMicrophoneUsageDescription',
      'NSSpeechRecognitionUsageDescription'
    ]) {
      if (typeof mac.extendInfo?.[usageKey] !== 'string' || !mac.extendInfo[usageKey].trim()) {
        errors.push(`effective trusted release config must declare ${usageKey}`)
      }
    }

    const filters = (config.files ?? []).flatMap((entry) =>
      typeof entry === 'string' ? [entry] : (entry.filter ?? [])
    )
    for (const exclusion of [
      '!**/.jarvis{,/**/*}',
      '!**/{auth.json,electron-builder.env}',
      '!**/*.{p12,pfx,p8,cer,pem,key,mobileprovision,jks}'
    ]) {
      if (!filters.includes(exclusion)) {
        errors.push(`effective trusted release config must exclude ${exclusion}`)
      }
    }

    for (const requestedArch of ['arm64', 'x64']) {
      const requestedArchCode = Arch[requestedArch]
      const rawTargets = new Map([[requestedArchCode, []]])
      const resolvedTargets = computeArchToTargetNamesMap(
        rawTargets,
        {
          platformSpecificBuildOptions: mac,
          defaultTarget: ['dmg', 'zip']
        },
        Platform.MAC
      )
      const resolvedArchitectures = [...resolvedTargets.keys()].map((value) => Arch[value])
      const targets = [...new Set(resolvedTargets.get(requestedArchCode) ?? [])].sort()
      if (
        resolvedTargets.size !== 1 ||
        resolvedArchitectures[0] !== requestedArch ||
        targets.join(',') !== 'dmg,zip'
      ) {
        errors.push(
          `effective trusted release target for ${requestedArch} must resolve only to ${requestedArch} DMG + ZIP (resolved ${resolvedArchitectures.join(', ') || 'none'}: ${targets.join(', ') || 'none'})`
        )
      }
    }
  } catch (error) {
    errors.push(
      `trusted release config could not be resolved by electron-builder: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

if (errors.length > 0) {
  console.error(`${configOnly ? 'Release configuration' : 'Trusted release'} preflight failed:`)
  for (const error of errors) console.error(`  - ${error}`)
  console.error('No certificate, password, API key, or token value was printed.')
  process.exit(1)
}

if (configOnly) {
  console.log(
    `Release configuration preflight passed for Jarvis ${pkg.version} (${targetArch}); Apple secret values were intentionally not evaluated.`
  )
} else {
  console.log(
    `Trusted release preflight passed for Jarvis ${pkg.version} (${targetArch}); all required secret names are populated.`
  )
}
