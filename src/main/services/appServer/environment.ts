import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { CodexExecutableError } from './errors'
import { JARVIS_CODEX_CONFIG_TOML } from './permissions'

const POSIX_SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

const PASSTHROUGH_ENV_KEYS = [
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT'
] as const

export interface MinimalChildEnvironmentOptions {
  platform?: NodeJS.Platform
  source?: NodeJS.ProcessEnv
}

/**
 * Create the app-server environment from an allowlist. In particular, API keys,
 * endpoint overrides, proxy credentials, and the parent CODEX_HOME never cross
 * the process boundary.
 */
export function buildMinimalChildEnvironment(
  codexHome: string,
  options: MinimalChildEnvironmentOptions = {}
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform
  const source = options.source ?? process.env
  const home = resolve(codexHome)
  const env: NodeJS.ProcessEnv = {
    CODEX_HOME: home,
    NO_COLOR: '1',
    RUST_BACKTRACE: '0',
    TERM: 'dumb'
  }

  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }

  if (platform === 'win32') {
    env.USERPROFILE = home
    env.HOME = home
    if (!env.SystemRoot && source.SystemRoot) env.SystemRoot = source.SystemRoot
    if (!env.WINDIR && source.WINDIR) env.WINDIR = source.WINDIR
    env.PATH = `${env.SystemRoot ?? 'C:\\Windows'}\\System32`
  } else {
    env.HOME = home
    env.PATH = POSIX_SYSTEM_PATH
  }

  return env
}

/** Create and verify the private filesystem boundary used as CODEX_HOME. */
export async function prepareIsolatedCodexHome(codexHome: string): Promise<string> {
  const physical = await preparePrivateDirectory(codexHome, 'Configured CODEX_HOME')
  await installPinnedCodexConfig(physical)
  return physical
}

/** Create a private, physical directory that cannot be replaced by a symlink. */
export async function preparePrivateDirectory(
  directory: string,
  label = 'Runtime directory'
): Promise<string> {
  const requested = resolve(directory)
  await mkdir(requested, { recursive: true, mode: 0o700 })

  const info = await lstat(requested)
  if (info.isSymbolicLink()) {
    throw new CodexExecutableError(`${label} must not be a symlink`)
  }
  if (!info.isDirectory()) {
    throw new CodexExecutableError(`${label} is not a directory`)
  }
  await chmod(requested, 0o700)
  return realpath(requested)
}

async function installPinnedCodexConfig(codexHome: string): Promise<void> {
  const path = join(codexHome, 'config.toml')
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_CREAT | constants.O_WRONLY | noFollow, 0o600)
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new CodexExecutableError('Jarvis Codex configuration is not a private regular file')
    }
    await handle.truncate(0)
    await handle.writeFile(JARVIS_CODEX_CONFIG_TOML, 'utf8')
    await handle.chmod(0o600)
    await handle.sync()
  } catch (error) {
    if (error instanceof CodexExecutableError) throw error
    throw new CodexExecutableError(
      `Jarvis could not install its private Codex configuration: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
