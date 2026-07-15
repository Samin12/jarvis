/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..')
const SCHEMA_VERSION = 1
const MANIFEST_NAME = 'manifest.json'
const CODEX_VERSION = '0.144.3'
const CODEX_TAG = `rust-v${CODEX_VERSION}`
const CODEX_REPOSITORY = 'https://github.com/openai/codex'
const CODEX_LICENSE_SHA256 = 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc'
const CODEX_NOTICE_SHA256 = '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915'

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path))
}

function physicalFile(path, label) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${label} must be a physical file`)
  }
  return info
}

function readPackage(packageName) {
  const path = join(REPOSITORY_ROOT, 'node_modules', ...packageName.split('/'), 'package.json')
  physicalFile(path, `${packageName} package metadata`)
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value.name !== packageName || typeof value.version !== 'string') {
    throw new Error(`${packageName} package metadata is invalid`)
  }
  return value
}

function normalizeRepository(repository) {
  if (typeof repository === 'string') {
    return { url: repository.replace(/^git\+/u, ''), directory: null }
  }
  if (repository && typeof repository.url === 'string') {
    return {
      url: repository.url.replace(/^git\+/u, ''),
      directory: typeof repository.directory === 'string' ? repository.directory : null
    }
  }
  throw new Error('Package repository metadata is missing')
}

function packageComponent(packageName, license, outputPath, sourcePath) {
  const pkg = readPackage(packageName)
  if (pkg.license !== license) {
    throw new Error(`${packageName} declares ${String(pkg.license)}, expected ${license}`)
  }
  return {
    name: packageName,
    version: pkg.version,
    license,
    repository: normalizeRepository(pkg.repository),
    files: [{ path: outputPath, source: sourcePath }]
  }
}

function componentSpecifications() {
  const nodeModules = join(REPOSITORY_ROOT, 'node_modules')
  const electron = readPackage('electron')
  const codex = readPackage('@openai/codex')
  const codexSdk = readPackage('@openai/codex-sdk')
  if (codex.version !== CODEX_VERSION || codexSdk.version !== CODEX_VERSION) {
    throw new Error(
      `Codex legal evidence is pinned to ${CODEX_VERSION}; installed versions are ${codex.version} and ${codexSdk.version}`
    )
  }

  const codexLicense = join(nodeModules, '@openai', 'codex-sdk', 'LICENSE')
  const codexNotice = join(REPOSITORY_ROOT, 'legal', 'openai-codex-NOTICE.txt')
  physicalFile(codexLicense, 'Codex Apache license source')
  physicalFile(codexNotice, 'Codex NOTICE source')
  if (sha256File(codexLicense) !== CODEX_LICENSE_SHA256) {
    throw new Error(`Codex ${CODEX_TAG} Apache license evidence changed`)
  }
  if (sha256File(codexNotice) !== CODEX_NOTICE_SHA256) {
    throw new Error(`Codex ${CODEX_TAG} NOTICE evidence changed`)
  }

  return [
    packageComponent(
      'electron',
      'MIT',
      'components/electron/LICENSE.txt',
      join(nodeModules, 'electron', 'LICENSE')
    ),
    {
      name: 'Chromium and bundled third-party components',
      version: `bundled-with-electron-${electron.version}`,
      license: 'Multiple (see LICENSES.chromium.html)',
      repository: { url: 'https://chromium.googlesource.com/chromium/src', directory: null },
      files: [
        {
          path: 'components/chromium/LICENSES.chromium.html',
          source: join(nodeModules, 'electron', 'dist', 'LICENSES.chromium.html')
        }
      ]
    },
    {
      name: '@openai/codex',
      version: codex.version,
      license: 'Apache-2.0',
      repository: normalizeRepository(codex.repository),
      files: [
        { path: 'components/openai-codex/LICENSE.txt', source: codexLicense },
        { path: 'components/openai-codex/NOTICE.txt', source: codexNotice }
      ]
    },
    {
      name: '@openai/codex-sdk',
      version: codexSdk.version,
      license: 'Apache-2.0',
      repository: normalizeRepository(codexSdk.repository),
      files: [{ path: 'components/openai-codex-sdk/LICENSE.txt', source: codexLicense }]
    },
    packageComponent(
      'react',
      'MIT',
      'components/react/LICENSE.txt',
      join(nodeModules, 'react', 'LICENSE')
    ),
    packageComponent(
      'react-dom',
      'MIT',
      'components/react-dom/LICENSE.txt',
      join(nodeModules, 'react-dom', 'LICENSE')
    ),
    packageComponent(
      'scheduler',
      'MIT',
      'components/scheduler/LICENSE.txt',
      join(nodeModules, 'scheduler', 'LICENSE')
    ),
    packageComponent(
      'three',
      'MIT',
      'components/three/LICENSE.txt',
      join(nodeModules, 'three', 'LICENSE')
    ),
    packageComponent(
      '@electron-toolkit/utils',
      'MIT',
      'components/electron-toolkit-utils/LICENSE.txt',
      join(nodeModules, '@electron-toolkit', 'utils', 'LICENSE')
    ),
    packageComponent(
      '@fontsource/big-shoulders',
      'OFL-1.1',
      'components/fontsource-big-shoulders/LICENSE.txt',
      join(nodeModules, '@fontsource', 'big-shoulders', 'LICENSE')
    ),
    packageComponent(
      '@fontsource/martian-mono',
      'OFL-1.1',
      'components/fontsource-martian-mono/LICENSE.txt',
      join(nodeModules, '@fontsource', 'martian-mono', 'LICENSE')
    )
  ]
}

function expectedManifest() {
  const components = componentSpecifications().map((component) => ({
    name: component.name,
    version: component.version,
    license: component.license,
    repository: component.repository,
    files: component.files.map((file) => {
      const info = physicalFile(file.source, `${component.name} legal source`)
      return { path: file.path, bytes: info.size, sha256: sha256File(file.source) }
    })
  }))
  const files = components.flatMap((component) => component.files)
  return {
    schemaVersion: SCHEMA_VERSION,
    format: 'jarvis-third-party-legal-notices',
    codexEvidence: {
      repository: CODEX_REPOSITORY,
      tag: CODEX_TAG,
      treeUrl: `${CODEX_REPOSITORY}/tree/${CODEX_TAG}`,
      license: {
        path: 'components/openai-codex/LICENSE.txt',
        upstreamUrl: `https://raw.githubusercontent.com/openai/codex/${CODEX_TAG}/LICENSE`,
        sha256: CODEX_LICENSE_SHA256
      },
      notice: {
        path: 'components/openai-codex/NOTICE.txt',
        upstreamUrl: `https://raw.githubusercontent.com/openai/codex/${CODEX_TAG}/NOTICE`,
        sha256: CODEX_NOTICE_SHA256
      }
    },
    componentCount: components.length,
    fileCount: files.length,
    components
  }
}

function manifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function expectedDirectories(filePaths) {
  const directories = new Set()
  for (const path of filePaths) {
    let current = dirname(path)
    while (current !== '.') {
      directories.add(current.replaceAll('\\', '/'))
      current = dirname(current)
    }
  }
  return directories
}

function verifyExactPhysicalTree(root, expectedFiles) {
  const rootInfo = lstatSync(root)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('Legal-notice root must be a physical directory')
  }

  const expectedFileSet = new Set(expectedFiles)
  const expectedDirectorySet = expectedDirectories(expectedFiles)
  const foundFiles = new Set()
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const displayPath = relative(root, path).replaceAll('\\', '/')
      const info = lstatSync(path)
      if (info.isSymbolicLink()) {
        throw new Error(`Legal-notice tree contains a symlink: ${displayPath}`)
      }
      if (info.isDirectory()) {
        if (!expectedDirectorySet.has(displayPath)) {
          throw new Error(`Legal-notice tree contains an extra directory: ${displayPath}`)
        }
        queue.push(path)
        continue
      }
      if (!info.isFile()) {
        throw new Error(`Legal-notice tree contains a special file: ${displayPath}`)
      }
      if (info.nlink !== 1) {
        throw new Error(`Legal-notice file must have exactly one physical link: ${displayPath}`)
      }
      if (!expectedFileSet.has(displayPath)) {
        throw new Error(`Legal-notice tree contains an extra file: ${displayPath}`)
      }
      foundFiles.add(displayPath)
    }
  }
  const missing = expectedFiles.filter((path) => !foundFiles.has(path))
  if (missing.length > 0) {
    throw new Error(`Legal-notice tree is missing: ${missing.join(', ')}`)
  }
}

function summary(root, manifest) {
  const path = join(root, MANIFEST_NAME)
  const info = physicalFile(path, 'Legal-notice manifest')
  return {
    schemaVersion: manifest.schemaVersion,
    componentCount: manifest.componentCount,
    fileCount: manifest.fileCount,
    codexTag: manifest.codexEvidence.tag,
    manifestBytes: info.size,
    manifestSha256: sha256File(path)
  }
}

function assertManagedLegalOutput(root) {
  const manifestPath = join(root, MANIFEST_NAME)
  try {
    const info = physicalFile(manifestPath, 'Existing legal-notice manifest')
    if (info.nlink !== 1) throw new Error('manifest must have one physical link')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (
      manifest?.schemaVersion !== SCHEMA_VERSION ||
      manifest?.format !== 'jarvis-third-party-legal-notices' ||
      !Array.isArray(manifest.components)
    ) {
      throw new Error('manifest marker is invalid')
    }
  } catch (error) {
    throw new Error(
      `Refusing to replace an unmanaged directory at ${root}: ${error instanceof Error ? error.message : error}`
    )
  }
}

export function verifyLegalNotices(directory) {
  const root = resolve(directory)
  const manifest = expectedManifest()
  const legalFiles = manifest.components.flatMap((component) =>
    component.files.map((file) => file.path)
  )
  const expectedFiles = [MANIFEST_NAME, ...legalFiles].sort()
  verifyExactPhysicalTree(root, expectedFiles)

  const rawManifest = readFileSync(join(root, MANIFEST_NAME), 'utf8')
  if (rawManifest !== manifestText(manifest)) {
    throw new Error('Legal-notice manifest is missing, malformed, non-canonical, or tampered')
  }
  for (const component of manifest.components) {
    for (const file of component.files) {
      const outputPath = join(root, ...file.path.split('/'))
      const info = physicalFile(outputPath, `${component.name} bundled legal file`)
      if (info.nlink !== 1 || info.size !== file.bytes || sha256File(outputPath) !== file.sha256) {
        throw new Error(`Bundled legal file is missing or tampered: ${file.path}`)
      }
    }
  }
  return summary(root, manifest)
}

export function buildLegalNotices(directory) {
  const outputRoot = resolve(directory)
  if (outputRoot === REPOSITORY_ROOT || outputRoot === dirname(outputRoot)) {
    throw new Error('Refusing to replace an unsafe legal-notice output directory')
  }
  let existingIdentity = null
  if (existsSync(outputRoot)) {
    const info = lstatSync(outputRoot)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Existing legal-notice output must be a physical directory')
    }
    assertManagedLegalOutput(outputRoot)
    existingIdentity = { dev: info.dev, ino: info.ino }
  }

  const manifest = expectedManifest()
  const specs = componentSpecifications()
  const stagingRoot = join(
    dirname(outputRoot),
    `.${basename(outputRoot)}.staging-${process.pid}-${randomUUID()}`
  )
  const backupRoot = join(
    dirname(outputRoot),
    `.${basename(outputRoot)}.backup-${process.pid}-${randomUUID()}`
  )
  let backupCreated = false
  try {
    mkdirSync(stagingRoot, { recursive: false, mode: 0o755 })
    for (const component of specs) {
      for (const file of component.files) {
        physicalFile(file.source, `${component.name} legal source`)
        const destination = join(stagingRoot, ...file.path.split('/'))
        mkdirSync(dirname(destination), { recursive: true, mode: 0o755 })
        copyFileSync(file.source, destination)
        chmodSync(destination, 0o644)
      }
    }
    const manifestPath = join(stagingRoot, MANIFEST_NAME)
    writeFileSync(manifestPath, manifestText(manifest), { encoding: 'utf8', mode: 0o644 })
    verifyLegalNotices(stagingRoot)
    if (existingIdentity) {
      const current = lstatSync(outputRoot)
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        current.dev !== existingIdentity.dev ||
        current.ino !== existingIdentity.ino
      ) {
        throw new Error('Existing legal-notice output changed before replacement')
      }
      renameSync(outputRoot, backupRoot)
      backupCreated = true
    }
    renameSync(stagingRoot, outputRoot)
    const result = verifyLegalNotices(outputRoot)
    if (backupCreated) {
      rmSync(backupRoot, { recursive: true, force: false })
      backupCreated = false
    }
    return result
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true })
    if (backupCreated && !existsSync(outputRoot) && existsSync(backupRoot)) {
      renameSync(backupRoot, outputRoot)
      backupCreated = false
    }
    throw error
  }
}

function parseCli(argv) {
  const [action, flag, value, ...extra] = argv
  if (extra.length > 0 || !['build', 'verify'].includes(action)) {
    throw new Error('Usage: legal-notices.mjs build --out <directory> | verify --dir <directory>')
  }
  if (action === 'build' && flag === '--out' && value) return { action, directory: value }
  if (action === 'verify' && flag === '--dir' && value) return { action, directory: value }
  throw new Error('Usage: legal-notices.mjs build --out <directory> | verify --dir <directory>')
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  const { action, directory } = parseCli(process.argv.slice(2))
  const result = action === 'build' ? buildLegalNotices(directory) : verifyLegalNotices(directory)
  console.log(JSON.stringify(result, null, 2))
}
