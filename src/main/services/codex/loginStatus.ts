/**
 * Codex login detection. Per research (docs/research/codex-bridge.md §6):
 * detect login by running `codex login status`, NOT by parsing ~/.codex/auth.json
 * (the credential store may be keyring-backed). Resolve the SDK's bundled binary
 * first (Finder-launched Electron apps get a minimal PATH), then fall back to PATH
 * and common install locations. Handles codex-not-installed gracefully.
 */
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64'
}

function targetTriple(): string | null {
  const { platform, arch } = process
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : arch === 'x64' ? 'x86_64-apple-darwin' : null
  }
  if (platform === 'linux' || platform === 'android') {
    return arch === 'arm64'
      ? 'aarch64-unknown-linux-musl'
      : arch === 'x64'
        ? 'x86_64-unknown-linux-musl'
        : null
  }
  if (platform === 'win32') {
    return arch === 'arm64'
      ? 'aarch64-pc-windows-msvc'
      : arch === 'x64'
        ? 'x86_64-pc-windows-msvc'
        : null
  }
  return null
}

/**
 * Mirror of the SDK's findCodexPath(): resolve @openai/codex -> platform package
 * -> vendor/<triple>/bin/codex. Returns null when not resolvable.
 */
export function resolveBundledCodexBinary(): string | null {
  const triple = targetTriple()
  if (!triple) return null
  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[triple]
  if (!platformPackage) return null
  const binName = process.platform === 'win32' ? 'codex.exe' : 'codex'
  try {
    const req = createRequire(import.meta.url)
    const codexPkgJson = req.resolve('@openai/codex/package.json')
    const codexReq = createRequire(codexPkgJson)
    const platformPkgJson = codexReq.resolve(`${platformPackage}/package.json`)
    const vendorRoot = join(dirname(platformPkgJson), 'vendor', triple)
    for (const candidate of [
      join(vendorRoot, 'bin', binName),
      join(vendorRoot, 'codex', binName)
    ]) {
      if (existsSync(candidate)) return candidate
    }
    return null
  } catch {
    return null
  }
}

/** Best codex binary to spawn: bundled SDK binary, then common installs, then bare PATH lookup. */
export function resolveCodexBinary(): string {
  const bundled = resolveBundledCodexBinary()
  if (bundled) return bundled
  const home = homedir()
  const candidates = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(home, '.local', 'bin', 'codex'),
    join(home, '.npm-global', 'bin', 'codex')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'codex' // last resort: whatever PATH the process inherited
}

const LOGIN_STATUS_TIMEOUT_MS = 10_000

/**
 * Runs `codex login status`. Exit code 0 => logged in.
 * Never rejects: spawn failures (codex not installed) resolve to { loggedIn: false }.
 */
export async function getCodexLoginStatus(): Promise<{ loggedIn: boolean }> {
  const bin = resolveCodexBinary()
  return new Promise((resolve) => {
    let settled = false
    const done = (loggedIn: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ loggedIn })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, ['login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ loggedIn: false })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      done(false)
    }, LOGIN_STATUS_TIMEOUT_MS)
    child.on('error', () => done(false)) // ENOENT: codex not installed anywhere
    child.on('close', (code) => done(code === 0))
  })
}
