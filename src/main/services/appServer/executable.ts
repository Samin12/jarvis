import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { CodexExecutableError } from './errors'
import { buildMinimalChildEnvironment } from './environment'
import { CODEX_PROTOCOL_SCHEMA_SHA256, CODEX_PROTOCOL_VERSION } from './protocol'

interface TargetDescriptor {
  triple: string
  platformPackage: string
  platformVersion: string
  binaryName: string
}

const TARGETS: Readonly<Record<string, TargetDescriptor>> = {
  'darwin:arm64': {
    triple: 'aarch64-apple-darwin',
    platformPackage: '@openai/codex-darwin-arm64',
    platformVersion: `${CODEX_PROTOCOL_VERSION}-darwin-arm64`,
    binaryName: 'codex'
  },
  'darwin:x64': {
    triple: 'x86_64-apple-darwin',
    platformPackage: '@openai/codex-darwin-x64',
    platformVersion: `${CODEX_PROTOCOL_VERSION}-darwin-x64`,
    binaryName: 'codex'
  },
  'linux:arm64': {
    triple: 'aarch64-unknown-linux-musl',
    platformPackage: '@openai/codex-linux-arm64',
    platformVersion: `${CODEX_PROTOCOL_VERSION}-linux-arm64`,
    binaryName: 'codex'
  },
  'linux:x64': {
    triple: 'x86_64-unknown-linux-musl',
    platformPackage: '@openai/codex-linux-x64',
    platformVersion: `${CODEX_PROTOCOL_VERSION}-linux-x64`,
    binaryName: 'codex'
  },
  'win32:arm64': {
    triple: 'aarch64-pc-windows-msvc',
    platformPackage: '@openai/codex-win32-arm64',
    platformVersion: `${CODEX_PROTOCOL_VERSION}-win32-arm64`,
    binaryName: 'codex.exe'
  },
  'win32:x64': {
    triple: 'x86_64-pc-windows-msvc',
    platformPackage: '@openai/codex-win32-x64',
    platformVersion: `${CODEX_PROTOCOL_VERSION}-win32-x64`,
    binaryName: 'codex.exe'
  }
}

export interface CodexResolutionContext {
  isPackaged: boolean
  /** Development project root (the directory containing node_modules). */
  appRoot: string
  /** Electron's process.resourcesPath. Required for packaged resolution. */
  resourcesPath?: string
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
  /** Extra explicit development roots. Never consulted in a packaged build. */
  additionalDevelopmentRoots?: readonly string[]
}

export interface ResolvedCodexExecutable {
  path: string
  sha256: string
  protocolVersion: typeof CODEX_PROTOCOL_VERSION
  protocolSchemaSha256: typeof CODEX_PROTOCOL_SCHEMA_SHA256
  platformPackage: string
  platformPackageVersion: string
  targetTriple: string
  source: 'development' | 'packaged'
}

interface PackageJson {
  name?: unknown
  version?: unknown
}

export function targetFor(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): TargetDescriptor {
  const target = TARGETS[`${platform}:${arch}`]
  if (!target) {
    throw new CodexExecutableError(`Codex does not support ${platform}/${arch}`)
  }
  return target
}

export function codexExecutableCandidates(context: CodexResolutionContext): readonly string[] {
  const target = targetFor(context.platform, context.arch)
  const packageParts = target.platformPackage.split('/')

  if (context.isPackaged) {
    if (!context.resourcesPath) {
      throw new CodexExecutableError('resourcesPath is required in a packaged build')
    }
    return [
      join(
        resolve(context.resourcesPath),
        'app.asar.unpacked',
        'node_modules',
        ...packageParts,
        'vendor',
        target.triple,
        'bin',
        target.binaryName
      )
    ]
  }

  const roots = [context.appRoot, ...(context.additionalDevelopmentRoots ?? [])]
  return roots.map((root) =>
    join(
      resolve(root),
      'node_modules',
      ...packageParts,
      'vendor',
      target.triple,
      'bin',
      target.binaryName
    )
  )
}

/**
 * Resolve only the pinned, package-owned native executable. This deliberately
 * has no implicit PATH or global-install fallback.
 */
export async function resolveBundledCodexExecutable(
  context: CodexResolutionContext
): Promise<ResolvedCodexExecutable> {
  const target = targetFor(context.platform, context.arch)
  const candidates = codexExecutableCandidates(context)
  const failures: string[] = []

  for (const candidate of candidates) {
    try {
      const physical = await verifyPhysicalExecutable(
        candidate,
        context.platform ?? process.platform
      )
      if (context.isPackaged) {
        const unpackedRoot = await realpath(
          join(resolve(context.resourcesPath!), 'app.asar.unpacked')
        )
        assertPathWithin(unpackedRoot, physical)
      }
      const platformPackageRoot = dirnameUpTo(physical, target.platformPackage.split('/').at(-1)!)
      const nodeModulesRoot = dirname(dirname(platformPackageRoot))
      const platformManifest = await readPackageJson(join(platformPackageRoot, 'package.json'))
      const baseManifest = await readPackageJson(
        join(nodeModulesRoot, '@openai', 'codex', 'package.json')
      )

      if (platformManifest.version !== target.platformVersion) {
        throw new Error(
          `platform package is ${String(platformManifest.version)}, expected ${target.platformVersion}`
        )
      }
      if (
        baseManifest.name !== '@openai/codex' ||
        baseManifest.version !== CODEX_PROTOCOL_VERSION
      ) {
        throw new Error(
          `base package is ${String(baseManifest.name)}@${String(baseManifest.version)}, expected @openai/codex@${CODEX_PROTOCOL_VERSION}`
        )
      }

      return {
        path: physical,
        sha256: await sha256File(physical),
        protocolVersion: CODEX_PROTOCOL_VERSION,
        protocolSchemaSha256: CODEX_PROTOCOL_SCHEMA_SHA256,
        platformPackage: target.platformPackage,
        platformPackageVersion: target.platformVersion,
        targetTriple: target.triple,
        source: context.isPackaged ? 'packaged' : 'development'
      }
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new CodexExecutableError(
    `Pinned Codex ${CODEX_PROTOCOL_VERSION} executable was not found. ${failures.join('; ')}`,
    candidates
  )
}

async function verifyPhysicalExecutable(path: string, platform: NodeJS.Platform): Promise<string> {
  const lexical = resolve(path)
  if (isVirtualAsarPath(lexical)) {
    throw new Error('virtual app.asar paths cannot be executed')
  }
  await access(lexical, platform === 'win32' ? constants.F_OK : constants.X_OK)
  const physical = await realpath(lexical)
  if (isVirtualAsarPath(physical)) throw new Error('real path resolves inside app.asar')
  const info = await stat(physical)
  if (!info.isFile()) throw new Error('path is not a regular file')
  return physical
}

export function isVirtualAsarPath(path: string): boolean {
  const segments = resolve(path).split(sep)
  return segments.some(
    (segment) => segment.endsWith('.asar') && !segment.endsWith('.asar.unpacked')
  )
}

function assertPathWithin(root: string, candidate: string): void {
  const displacement = relative(root, candidate)
  if (displacement === '..' || displacement.startsWith(`..${sep}`) || isAbsolute(displacement)) {
    throw new Error('packaged executable resolves outside app.asar.unpacked')
  }
}

function dirnameUpTo(path: string, expectedDirectoryName: string): string {
  let current = dirname(path)
  while (dirname(current) !== current) {
    if (basename(current) === expectedDirectoryName) return current
    current = dirname(current)
  }
  throw new Error(`executable is not contained by ${expectedDirectoryName}`)
}

async function readPackageJson(path: string): Promise<PackageJson> {
  const text = await readFile(path, 'utf8')
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a package manifest`)
  }
  return parsed as PackageJson
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export interface CodexVersionProbeOptions {
  codexHome: string
  timeoutMs?: number
  maxOutputBytes?: number
}

/** Execute the physical binary and require an exact version report. */
export async function verifyCodexExecutableVersion(
  executable: ResolvedCodexExecutable,
  options: CodexVersionProbeOptions
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024

  await new Promise<void>((resolveProbe, rejectProbe) => {
    const child = spawn(executable.path, ['--version'], {
      env: buildMinimalChildEnvironment(options.codexHome),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectProbe(error)
      else resolveProbe()
    }
    const collect = (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > maxOutputBytes) {
        child.kill('SIGKILL')
        finish(new CodexExecutableError('Codex version output exceeded its safety bound'))
        return
      }
      chunks.push(Buffer.from(chunk))
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) =>
      finish(new CodexExecutableError('Unable to execute Codex', [], { cause: error }))
    )
    child.on('close', (code) => {
      if (settled) return
      const output = Buffer.concat(chunks).toString('utf8').trim()
      const version = output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1]
      if (code !== 0 || version !== CODEX_PROTOCOL_VERSION) {
        finish(
          new CodexExecutableError(
            `Codex reported ${version ?? 'no version'} with exit ${String(code)}; expected ${CODEX_PROTOCOL_VERSION}`
          )
        )
        return
      }
      finish()
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new CodexExecutableError(`Codex version probe timed out after ${timeoutMs} ms`))
    }, timeoutMs)
  })
}
