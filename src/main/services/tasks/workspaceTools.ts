import { createHash } from 'node:crypto'
import { constants as fsConstants, type BigIntStats, type Dirent } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  DynamicToolCallParams,
  DynamicToolFunctionSpec,
  DynamicToolNamespaceSpec,
  DynamicToolCallResponse
} from '../appServer'
import { revalidateWorkspaceScope, stableJson, type WorkspaceScope } from '../actions'

export const TASK_WORKSPACE_TOOL_NAMESPACE = 'jarvis_workspace'

const LIST_FILES_TOOL = 'list_files'
const READ_TEXT_TOOL = 'read_text'
const SEARCH_TEXT_TOOL = 'search_text'
const WRITE_TEXT_TOOL = 'write_text'

const MAX_PATH_CHARS = 2_048
const MAX_PATH_SEGMENTS = 128
const MAX_LIST_RESULTS = 512
const MAX_LIST_ENTRIES_SCANNED = 1_024
const MAX_LIST_RESULT_BYTES = 48 * 1024
const MAX_READ_BYTES = 48 * 1024
const MAX_SEARCH_QUERY_CHARS = 1_024
const MAX_SEARCH_FILES = 512
const MAX_SEARCH_DIRECTORIES = 256
const MAX_SEARCH_ENTRIES_PER_DIRECTORY = 1_024
const MAX_SEARCH_DEPTH = 24
const MAX_SEARCH_FILE_BYTES = 128 * 1024
const MAX_SEARCH_TOTAL_BYTES = 4 * 1024 * 1024
const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_RESULT_BYTES = 48 * 1024
const MAX_WRITE_BYTES = 192 * 1024

const TOOL_CALL_KEYS = ['arguments', 'callId', 'namespace', 'threadId', 'tool', 'turnId'] as const

const LIST_FILES_SPEC: DynamicToolFunctionSpec = {
  type: 'function',
  name: LIST_FILES_TOOL,
  description:
    'List the immediate safe files and directories at a workspace-relative directory path.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { path: { type: 'string', maxLength: MAX_PATH_CHARS } },
    required: ['path']
  }
}

const READ_TEXT_SPEC: DynamicToolFunctionSpec = {
  type: 'function',
  name: READ_TEXT_TOOL,
  description: 'Read one bounded UTF-8 text file at a workspace-relative path.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { path: { type: 'string', maxLength: MAX_PATH_CHARS } },
    required: ['path']
  }
}

const SEARCH_TEXT_SPEC: DynamicToolFunctionSpec = {
  type: 'function',
  name: SEARCH_TEXT_TOOL,
  description:
    'Search for a case-sensitive literal string in bounded UTF-8 files below a workspace-relative file or directory.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', maxLength: MAX_PATH_CHARS },
      query: { type: 'string', minLength: 1, maxLength: MAX_SEARCH_QUERY_CHARS }
    },
    required: ['path', 'query']
  }
}

const WRITE_TEXT_SPEC: DynamicToolFunctionSpec = {
  type: 'function',
  name: WRITE_TEXT_TOOL,
  description:
    'Create or replace exactly one bounded UTF-8 text file after one-time host approval. Delete and move are unavailable.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', maxLength: MAX_PATH_CHARS },
      content: { type: 'string', maxLength: MAX_WRITE_BYTES }
    },
    required: ['path', 'content']
  }
}

const TASK_WORKSPACE_NAMESPACE_SPEC: DynamicToolNamespaceSpec = {
  type: 'namespace',
  name: TASK_WORKSPACE_TOOL_NAMESPACE,
  description:
    'Host-owned, workspace-scoped UTF-8 file tools. No shell, process, network, delete, or move capability.',
  tools: [LIST_FILES_SPEC, READ_TEXT_SPEC, SEARCH_TEXT_SPEC, WRITE_TEXT_SPEC]
}

export const TASK_WORKSPACE_DYNAMIC_TOOLS: readonly DynamicToolNamespaceSpec[] = Object.freeze([
  TASK_WORKSPACE_NAMESPACE_SPEC
])

type WorkspaceToolName =
  typeof LIST_FILES_TOOL | typeof READ_TEXT_TOOL | typeof SEARCH_TEXT_TOOL | typeof WRITE_TEXT_TOOL

type WorkspaceToolArguments =
  { path: string } | { path: string; query: string } | { path: string; content: string }

export interface ValidatedWorkspaceToolCall {
  namespace: typeof TASK_WORKSPACE_TOOL_NAMESPACE
  tool: WorkspaceToolName
  threadId: string
  turnId: string
  callId: string
  arguments: WorkspaceToolArguments
  fingerprint: string
}

export interface FileIdentity {
  dev: bigint
  ino: bigint
  nlink: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

interface StableFileRead {
  bytes: Buffer
  identity: FileIdentity
  mode: number
}

interface SafeRegularFile {
  path: string
  identity: FileIdentity
}

export interface WorkspaceTextReadPlan extends SafeRegularFile {
  relativePath: string
}

interface DirectoryIdentity {
  dev: bigint
  ino: bigint
}

export interface WorkspaceWritePlan {
  kind: 'add' | 'update'
  relativePath: string
  targetPath: string
  parentPath: string
  parentIdentity: DirectoryIdentity
  expected: Buffer
  previous: StableFileRead | null
  mode: number
}

export interface WorkspaceWriteVerification {
  verified: boolean
  reason: string
}

export function claimsTaskWorkspaceNamespace(input: unknown): boolean {
  return isPlainObject(input) && input.namespace === TASK_WORKSPACE_TOOL_NAMESPACE
}

export function hintedTaskThreadId(input: unknown): string | null {
  return isPlainObject(input) && typeof input.threadId === 'string' ? input.threadId : null
}

export function validateWorkspaceToolCall(input: unknown): ValidatedWorkspaceToolCall {
  if (!isPlainObject(input)) throw new Error('Workspace tool call must be a plain object')
  requireExactKeys(input, TOOL_CALL_KEYS)
  const params: DynamicToolCallParams = {
    namespace: input.namespace === null ? null : requireBoundedId(input.namespace, 'namespace', 64),
    tool: requireBoundedId(input.tool, 'tool', 128),
    threadId: requireBoundedId(input.threadId, 'threadId', 512),
    turnId: requireBoundedId(input.turnId, 'turnId', 512),
    callId: requireBoundedId(input.callId, 'callId', 512),
    arguments: input.arguments as DynamicToolCallParams['arguments']
  }
  if (params.namespace !== TASK_WORKSPACE_TOOL_NAMESPACE) {
    throw new Error('Tool call is outside the task workspace namespace')
  }
  if (!isWorkspaceToolName(params.tool)) throw new Error('Workspace tool is not allowlisted')
  if (!isPlainObject(params.arguments))
    throw new Error('Workspace tool arguments must be an object')

  let args: WorkspaceToolArguments
  if (params.tool === SEARCH_TEXT_TOOL) {
    requireExactKeys(params.arguments, ['path', 'query'])
    args = {
      path: requireRelativePath(params.arguments.path, true),
      query: requireSearchQuery(params.arguments.query)
    }
  } else if (params.tool === WRITE_TEXT_TOOL) {
    requireExactKeys(params.arguments, ['content', 'path'])
    const content = requireUtf8WriteContent(params.arguments.content)
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
      throw new Error(`Write content exceeds ${MAX_WRITE_BYTES} UTF-8 bytes`)
    }
    args = {
      path: requireRelativePath(params.arguments.path, false),
      content
    }
  } else {
    requireExactKeys(params.arguments, ['path'])
    args = {
      path: requireRelativePath(params.arguments.path, params.tool === LIST_FILES_TOOL)
    }
  }

  const normalized: Omit<ValidatedWorkspaceToolCall, 'fingerprint'> = {
    namespace: TASK_WORKSPACE_TOOL_NAMESPACE,
    tool: params.tool,
    threadId: params.threadId,
    turnId: params.turnId,
    callId: params.callId,
    arguments: args
  }
  return {
    ...normalized,
    fingerprint: createHash('sha256').update(stableJson(normalized)).digest('hex')
  }
}

export async function executeWorkspaceReadTool(
  scope: WorkspaceScope,
  call: ValidatedWorkspaceToolCall
): Promise<DynamicToolCallResponse> {
  if (call.tool === LIST_FILES_TOOL) {
    return successResult(await listWorkspaceDirectory(scope, call.arguments.path))
  }
  if (call.tool === READ_TEXT_TOOL) {
    return successResult(await readWorkspaceText(scope, call.arguments.path))
  }
  if (call.tool === SEARCH_TEXT_TOOL) {
    const args = call.arguments as { path: string; query: string }
    return successResult(await searchWorkspaceText(scope, args.path, args.query))
  }
  throw new Error('Write tools require the approval execution path')
}

export async function captureWorkspaceWritePlan(
  scope: WorkspaceScope,
  call: ValidatedWorkspaceToolCall
): Promise<WorkspaceWritePlan> {
  if (call.tool !== WRITE_TEXT_TOOL) throw new Error('Expected the workspace write tool')
  const args = call.arguments as { path: string; content: string }
  await revalidateWorkspaceScope(scope)
  const targetPath = scopedCandidate(scope, args.path)
  const parentPath = dirname(targetPath)
  const parent = await inspectSafeDirectory(scope, parentPath)
  const expected = Buffer.from(args.content, 'utf8')
  const targetStats = await lstatOrNull(targetPath)
  if (!targetStats) {
    return {
      kind: 'add',
      relativePath: args.path,
      targetPath,
      parentPath,
      parentIdentity: parent.identity,
      expected,
      previous: null,
      mode: 0o600
    }
  }
  const inspected = await inspectSafeRegularFile(scope, targetPath)
  const previous = await readStableRegularFile(inspected.path, MAX_WRITE_BYTES, inspected.identity)
  return {
    kind: 'update',
    relativePath: args.path,
    targetPath,
    parentPath,
    parentIdentity: parent.identity,
    expected,
    previous,
    mode: previous.mode
  }
}

export async function revalidateWorkspaceWritePlan(
  scope: WorkspaceScope,
  plan: WorkspaceWritePlan
): Promise<void> {
  await revalidateWorkspaceScope(scope)
  if (scopedCandidate(scope, plan.relativePath) !== plan.targetPath) {
    throw new Error('Workspace write path changed')
  }
  const parent = await inspectSafeDirectory(scope, plan.parentPath)
  if (!sameDirectoryIdentity(parent.identity, plan.parentIdentity)) {
    throw new Error('Workspace write parent directory changed')
  }
  const current = await lstatOrNull(plan.targetPath)
  if (plan.kind === 'add') {
    if (current) throw new Error('Workspace create target appeared after approval')
    return
  }
  if (!current || !plan.previous) throw new Error('Workspace update target disappeared')
  const inspected = await inspectSafeRegularFile(scope, plan.targetPath)
  const existing = await readStableRegularFile(inspected.path, MAX_WRITE_BYTES, inspected.identity)
  if (
    !sameStableFile(existing.identity, plan.previous.identity) ||
    !existing.bytes.equals(plan.previous.bytes)
  ) {
    throw new Error('Workspace update target changed after approval')
  }
}

export async function verifyWorkspaceWrite(
  scope: WorkspaceScope,
  plan: WorkspaceWritePlan
): Promise<WorkspaceWriteVerification> {
  try {
    await revalidateWorkspaceScope(scope)
    if (scopedCandidate(scope, plan.relativePath) !== plan.targetPath) {
      return { verified: false, reason: 'write_path_changed' }
    }
    const parent = await inspectSafeDirectory(scope, plan.parentPath)
    if (!sameDirectoryIdentity(parent.identity, plan.parentIdentity)) {
      return { verified: false, reason: 'write_parent_changed' }
    }
    const inspected = await inspectSafeRegularFile(scope, plan.targetPath)
    const after = await readStableRegularFile(inspected.path, MAX_WRITE_BYTES, inspected.identity)
    return after.bytes.equals(plan.expected)
      ? { verified: true, reason: 'exact_utf8_content_verified' }
      : { verified: false, reason: 'write_content_mismatch' }
  } catch {
    return { verified: false, reason: 'write_postcondition_failed' }
  }
}

export function workspaceToolFailure(text: string): DynamicToolCallResponse {
  return { contentItems: [{ type: 'inputText', text }], success: false }
}

function successResult(text: string): DynamicToolCallResponse {
  return { contentItems: [{ type: 'inputText', text }], success: true }
}

async function listWorkspaceDirectory(
  scope: WorkspaceScope,
  relativePath: string
): Promise<string> {
  const directory = await inspectSafeDirectory(scope, scopedCandidate(scope, relativePath))
  const scanned = await readBoundedDirectory(directory.path, MAX_LIST_ENTRIES_SCANNED)
  const output: string[] = []
  let outputBytes = 0
  let omitted = scanned.truncated ? 1 : 0
  for (const entry of scanned.entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (output.length >= MAX_LIST_RESULTS) {
      omitted += 1
      continue
    }
    const childRelative = joinRelative(relativePath, entry.name)
    if (isSensitiveRelativePath(childRelative)) {
      omitted += 1
      continue
    }
    const childType = await inspectSafeListEntry(scope, join(directory.path, entry.name))
    if (!childType) {
      omitted += 1
      continue
    }
    const line = JSON.stringify({
      path: childRelative,
      type: childType
    })
    const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8')
    if (outputBytes + lineBytes > MAX_LIST_RESULT_BYTES) {
      omitted += 1
      continue
    }
    output.push(line)
    outputBytes += lineBytes
  }
  const after = await inspectSafeDirectory(scope, directory.path)
  if (!sameDirectoryIdentity(directory.identity, after.identity)) {
    throw new Error('Workspace directory changed while listing')
  }
  if (omitted > 0) output.push(JSON.stringify({ omitted }))
  return output.length > 0 ? output.join('\n') : 'No safe entries found.'
}

async function inspectSafeListEntry(
  scope: WorkspaceScope,
  path: string
): Promise<'directory' | 'file' | null> {
  try {
    const stats = await lstat(path, { bigint: true })
    if (stats.isSymbolicLink()) return null
    if (stats.isDirectory()) {
      await inspectSafeDirectory(scope, path)
      return 'directory'
    }
    if (stats.isFile()) {
      await inspectSafeRegularFile(scope, path)
      return 'file'
    }
  } catch {
    // Entries that race, escape, or become unsafe are deliberately omitted.
  }
  return null
}

async function readWorkspaceText(scope: WorkspaceScope, relativePath: string): Promise<string> {
  const plan = await captureWorkspaceTextReadPlan(scope, relativePath)
  return executeWorkspaceTextReadPlan(scope, plan)
}

export async function captureWorkspaceTextReadPlan(
  scope: WorkspaceScope,
  relativePath: string
): Promise<WorkspaceTextReadPlan> {
  const path = requireRelativePath(relativePath, false)
  const file = await inspectSafeRegularFile(scope, scopedCandidate(scope, path))
  return { ...file, relativePath: path }
}

export async function executeWorkspaceTextReadPlan(
  scope: WorkspaceScope,
  plan: WorkspaceTextReadPlan
): Promise<string> {
  if (scopedCandidate(scope, plan.relativePath) !== plan.path) {
    throw new Error('Workspace read path changed after validation')
  }
  const read = await readStableRegularFile(plan.path, MAX_READ_BYTES, plan.identity)
  const rebound = await inspectSafeRegularFile(scope, plan.path)
  if (!sameStableFile(read.identity, rebound.identity)) {
    throw new Error('Workspace file or ancestor changed after reading')
  }
  return decodeUtf8(read.bytes, 'Workspace file')
}

async function searchWorkspaceText(
  scope: WorkspaceScope,
  relativePath: string,
  query: string
): Promise<string> {
  const target = scopedCandidate(scope, relativePath)
  await revalidateWorkspaceScope(scope)
  await assertNoSymlinkComponents(scope, target)
  const targetStats = await lstat(target, { bigint: true })
  if (targetStats.isSymbolicLink()) throw new Error('Search target must not be a symlink')
  let files: SafeRegularFile[]
  let truncated = false
  if (targetStats.isFile()) {
    files = [await inspectSafeRegularFile(scope, target)]
  } else if (targetStats.isDirectory()) {
    await inspectSafeDirectory(scope, target)
    const collected = await collectSearchFiles(scope, target, relativePath)
    files = collected.files
    truncated = collected.truncated
  } else {
    throw new Error('Search target must be a regular file or directory')
  }

  const output: string[] = []
  let outputBytes = 0
  let scannedBytes = 0
  for (const file of files) {
    let read: StableFileRead
    try {
      read = await readStableRegularFile(file.path, MAX_SEARCH_FILE_BYTES, file.identity)
    } catch {
      continue
    }
    const rebound = await inspectSafeRegularFile(scope, file.path)
    if (!sameStableFile(read.identity, rebound.identity)) {
      throw new Error('Search file or ancestor changed while reading')
    }
    if (scannedBytes + read.bytes.byteLength > MAX_SEARCH_TOTAL_BYTES) {
      truncated = true
      break
    }
    scannedBytes += read.bytes.byteLength
    let text: string
    try {
      text = decodeUtf8(read.bytes, 'Search file')
    } catch {
      continue
    }
    const pathFromRoot = relative(scope.realpath, file.path).split(sep).join('/')
    const lines = text.split(/\r?\n/u)
    for (let index = 0; index < lines.length; index += 1) {
      const column = lines[index]!.indexOf(query)
      if (column < 0) continue
      const line = JSON.stringify({
        path: pathFromRoot,
        line: index + 1,
        column: column + 1,
        text: truncateText(lines[index]!, 500)
      })
      const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8')
      if (
        output.length >= MAX_SEARCH_RESULTS ||
        outputBytes + lineBytes > MAX_SEARCH_RESULT_BYTES
      ) {
        truncated = true
        break
      }
      output.push(line)
      outputBytes += lineBytes
    }
    if (truncated && output.length >= MAX_SEARCH_RESULTS) break
  }
  if (truncated) output.push(JSON.stringify({ truncated: true }))
  return output.length > 0 ? output.join('\n') : 'No literal matches found.'
}

async function collectSearchFiles(
  scope: WorkspaceScope,
  root: string,
  rootRelative: string
): Promise<{ files: SafeRegularFile[]; truncated: boolean }> {
  const queue: Array<{ path: string; relativePath: string; depth: number }> = [
    { path: root, relativePath: rootRelative, depth: 0 }
  ]
  const files: SafeRegularFile[] = []
  let truncated = false
  let visitedDirectories = 0
  while (queue.length > 0) {
    const current = queue.shift()!
    visitedDirectories += 1
    if (visitedDirectories > MAX_SEARCH_DIRECTORIES) {
      truncated = true
      break
    }
    if (current.depth > MAX_SEARCH_DEPTH) {
      truncated = true
      continue
    }
    const directory = await inspectSafeDirectory(scope, current.path)
    const scanned = await readBoundedDirectory(directory.path, MAX_SEARCH_ENTRIES_PER_DIRECTORY)
    if (scanned.truncated) truncated = true
    for (const entry of scanned.entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (files.length >= MAX_SEARCH_FILES) {
        truncated = true
        return { files, truncated }
      }
      const childRelative = joinRelative(current.relativePath, entry.name)
      if (isSensitiveRelativePath(childRelative) || shouldSkipSearchEntry(entry)) continue
      const childPath = join(current.path, entry.name)
      const stats = await lstatOrNull(childPath)
      if (!stats || stats.isSymbolicLink()) continue
      if (stats.isDirectory()) {
        if (queue.length + visitedDirectories < MAX_SEARCH_DIRECTORIES) {
          queue.push({ path: childPath, relativePath: childRelative, depth: current.depth + 1 })
        } else {
          truncated = true
        }
      } else if (stats.isFile() && stats.nlink === 1n) {
        files.push(await inspectSafeRegularFile(scope, childPath))
      }
    }
    const rebound = await inspectSafeDirectory(scope, directory.path)
    if (!sameDirectoryIdentity(directory.identity, rebound.identity)) {
      throw new Error('Search directory changed while scanning')
    }
  }
  return { files, truncated }
}

function shouldSkipSearchEntry(entry: Dirent): boolean {
  return entry.name === 'node_modules' || entry.name === '.cache' || entry.name === 'dist'
}

async function readBoundedDirectory(
  path: string,
  maxEntries: number
): Promise<{ entries: Dirent[]; truncated: boolean }> {
  const handle = await opendir(path)
  const entries: Dirent[] = []
  let truncated = false
  try {
    for await (const entry of handle) {
      if (entries.length >= maxEntries) {
        truncated = true
        break
      }
      entries.push(entry)
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
  return { entries, truncated }
}

async function inspectSafeRegularFile(
  scope: WorkspaceScope,
  path: string
): Promise<SafeRegularFile> {
  await revalidateWorkspaceScope(scope)
  assertLexicallyInside(scope.realpath, path)
  assertNotSensitive(scope, path)
  await assertNoSymlinkComponents(scope, path)
  const stats = await lstat(path, { bigint: true })
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Workspace path is not a regular file')
  }
  if (stats.nlink !== 1n) throw new Error('Workspace file has multiple hard links')
  const canonical = await realpath(path)
  assertLexicallyInside(scope.realpath, canonical)
  return { path: canonical, identity: identityFromStats(stats) }
}

async function inspectSafeDirectory(
  scope: WorkspaceScope,
  path: string
): Promise<{ path: string; identity: DirectoryIdentity }> {
  await revalidateWorkspaceScope(scope)
  assertLexicallyInside(scope.realpath, path)
  assertNotSensitive(scope, path)
  await assertNoSymlinkComponents(scope, path)
  const stats = await lstat(path, { bigint: true })
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('Workspace path is not a directory')
  }
  const canonical = await realpath(path)
  assertLexicallyInside(scope.realpath, canonical)
  return { path: canonical, identity: { dev: stats.dev, ino: stats.ino } }
}

async function assertNoSymlinkComponents(scope: WorkspaceScope, path: string): Promise<void> {
  const offset = relative(scope.realpath, path)
  if (!offset) return
  let current = scope.realpath
  for (const segment of offset.split(sep)) {
    current = join(current, segment)
    const stats = await lstat(current, { bigint: true })
    if (stats.isSymbolicLink()) throw new Error('Workspace path traverses a symlink')
  }
}

async function readStableRegularFile(
  path: string,
  maxBytes: number,
  expectedIdentity?: FileIdentity
): Promise<StableFileRead> {
  const before = await lstat(path, { bigint: true })
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('Workspace file is not a physical regular file')
  }
  if (before.nlink !== 1n) throw new Error('Workspace file has multiple hard links')
  if (before.size > BigInt(maxBytes)) throw new Error(`Workspace file exceeds ${maxBytes} bytes`)
  if (expectedIdentity && !sameStableFile(identityFromStats(before), expectedIdentity)) {
    throw new Error('Workspace file identity changed after validation')
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameStableFile(identityFromStats(before), identityFromStats(opened))) {
      throw new Error('Workspace file changed while opening')
    }
    const bytes = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (read.bytesRead === 0) throw new Error('Workspace file changed while reading')
      offset += read.bytesRead
    }
    const extra = Buffer.alloc(1)
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      throw new Error('Workspace file grew while reading')
    }
    const afterHandle = await handle.stat({ bigint: true })
    const afterPath = await lstat(path, { bigint: true })
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameStableFile(identityFromStats(opened), identityFromStats(afterHandle)) ||
      !sameStableFile(identityFromStats(opened), identityFromStats(afterPath))
    ) {
      throw new Error('Workspace file raced while reading')
    }
    return {
      bytes,
      identity: identityFromStats(opened),
      mode: Number(opened.mode & 0o777n)
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function scopedCandidate(scope: WorkspaceScope, relativePath: string): string {
  const candidate = resolve(scope.realpath, relativePath)
  assertLexicallyInside(scope.realpath, candidate)
  assertNotSensitive(scope, candidate)
  return candidate
}

function assertLexicallyInside(root: string, candidate: string): void {
  const offset = relative(root, candidate)
  if (isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`)) {
    throw new Error('Workspace path escapes the selected scope')
  }
}

function assertNotSensitive(scope: WorkspaceScope, candidate: string): void {
  const offset = relative(scope.realpath, candidate).split(sep).join('/')
  if (isSensitiveRelativePath(offset)) {
    throw new Error('Workspace path targets protected credentials or repository controls')
  }
}

function isSensitiveRelativePath(value: string): boolean {
  const segments = value
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.toLowerCase())
  return segments.some((segment) => {
    if (
      segment === '.git' ||
      segment === '.hg' ||
      segment === '.svn' ||
      segment === '.ssh' ||
      segment === '.gnupg' ||
      segment === '.aws' ||
      segment === '.azure' ||
      segment === '.kube' ||
      segment === '.docker' ||
      segment === '.codex' ||
      segment === '.jarvis' ||
      segment === '.npmrc' ||
      segment === '.pypirc' ||
      segment === '.netrc' ||
      segment === '_netrc' ||
      segment === '.git-credentials' ||
      segment === '.gitconfig' ||
      segment === 'auth.json' ||
      segment === 'credentials' ||
      segment === 'credentials.json' ||
      segment === 'id_rsa' ||
      segment === 'id_ed25519' ||
      segment === 'secrets.json' ||
      segment === 'tokens.json' ||
      segment === 'secrets' ||
      segment === '.secrets' ||
      segment === 'tokens' ||
      segment === '.tokens'
    ) {
      return true
    }
    if (segment === '.env' || segment.startsWith('.env.')) return true
    return /\.(?:p12|pfx|p8|pem|key|mobileprovision|jks)$/u.test(segment)
  })
}

function requireRelativePath(value: unknown, allowRoot: boolean): string {
  const path = requireString(value, 'path')
  if (
    path.length === 0 ||
    path.length > MAX_PATH_CHARS ||
    path !== path.trim() ||
    hasControlCharacters(path) ||
    path.includes('\\') ||
    isAbsolute(path)
  ) {
    throw new Error('Workspace path is not a normalized relative path')
  }
  if (path === '.') {
    if (!allowRoot) throw new Error('Workspace file path must name a file')
    return path
  }
  const segments = path.split('/')
  if (
    segments.length > MAX_PATH_SEGMENTS ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('Workspace path contains traversal or empty segments')
  }
  if (isSensitiveRelativePath(path)) {
    throw new Error('Workspace path targets protected credentials or repository controls')
  }
  return path
}

function requireUtf8WriteContent(value: unknown): string {
  const content = requireString(value, 'content')
  if (content.includes('\0')) throw new Error('Write content must be UTF-8 text, not binary data')
  const encoded = Buffer.from(content, 'utf8')
  if (new TextDecoder('utf-8', { fatal: true }).decode(encoded) !== content) {
    throw new Error('Write content contains invalid Unicode')
  }
  return content
}

function requireSearchQuery(value: unknown): string {
  const query = requireString(value, 'query')
  if (
    query.length === 0 ||
    query.length > MAX_SEARCH_QUERY_CHARS ||
    query.includes('\0') ||
    query.includes('\n') ||
    query.includes('\r')
  ) {
    throw new Error('Search query must be one bounded literal line')
  }
  return query
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

function requireBoundedId(value: unknown, name: string, max: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value !== value.trim() ||
    hasControlCharacters(value)
  ) {
    throw new Error(`${name} is not a bounded normalized identifier`)
  }
  return value
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error('Object contains missing or additional properties')
  }
}

function isWorkspaceToolName(value: string): value is WorkspaceToolName {
  return (
    value === LIST_FILES_TOOL ||
    value === READ_TEXT_TOOL ||
    value === SEARCH_TEXT_TOOL ||
    value === WRITE_TEXT_TOOL
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function decodeUtf8(bytes: Buffer, label: string): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.includes('\0')) throw new Error(`${label} contains binary NUL bytes`)
  return text
}

function identityFromStats(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs
  }
}

function sameStableFile(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function lstatOrNull(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function joinRelative(parent: string, child: string): string {
  return parent === '.' ? child : `${parent}/${child}`
}

function truncateText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}
