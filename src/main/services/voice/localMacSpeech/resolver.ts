import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'

export interface LocalMacSpeechResolveOptions {
  isPackaged: boolean
  /** Electron's process.resourcesPath when packaged. */
  resourcesPath?: string
  /** Repository root in development. */
  projectRoot?: string
  architecture?: NodeJS.Architecture
  configuration?: 'debug' | 'release'
}

function directoryArchitecture(architecture: NodeJS.Architecture): 'arm64' | 'x86_64' {
  if (architecture === 'arm64') return 'arm64'
  if (architecture === 'x64') return 'x86_64'
  throw new Error(`Local macOS speech does not support ${architecture}`)
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const file = await stat(candidate)
    if (!file.isFile()) return false
    await access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolves only project-owned or package-owned helper locations; no PATH lookup. */
export async function resolveLocalMacSpeechExecutable(
  options: LocalMacSpeechResolveOptions
): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('Local macOS speech is available only on macOS')
  }
  const architecture = directoryArchitecture(options.architecture ?? process.arch)
  const configuration = options.configuration ?? 'release'
  const candidates: string[] = []

  if (options.isPackaged) {
    if (!options.resourcesPath) throw new Error('resourcesPath is required for a packaged app')
    candidates.push(
      path.resolve(
        options.resourcesPath,
        'native',
        'macos-speech',
        architecture,
        'jarvis-macos-speech'
      )
    )
  } else {
    if (!options.projectRoot) throw new Error('projectRoot is required in development')
    const packageRoot = path.resolve(options.projectRoot, 'native', 'macos-speech')
    candidates.push(
      path.join(
        packageRoot,
        '.build',
        `${architecture}-apple-macosx`,
        configuration,
        'jarvis-macos-speech'
      ),
      path.join(packageRoot, '.build', configuration, 'jarvis-macos-speech')
    )
  }

  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return candidate
  }
  throw new Error(`Local macOS speech helper is missing for ${architecture}`)
}
