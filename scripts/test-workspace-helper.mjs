#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  throw new Error('jarvis-workspace-helper integration tests require macOS')
}

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packagePath = join(repoRoot, 'native', 'macos-speech')
const swiftArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : null
if (!swiftArch) throw new Error(`Unsupported native-test architecture: ${process.arch}`)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    ...options
  })
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    throw new Error(
      `${command} ${args.join(' ')} failed${detail ? `:\n${detail.slice(-4000)}` : ''}`
    )
  }
  return `${result.stdout ?? ''}`.trim()
}

const binDirectory = run('/usr/bin/swift', [
  'build',
  '--package-path',
  packagePath,
  '--configuration',
  'debug',
  '--arch',
  swiftArch,
  '--show-bin-path'
])
const helper = join(binDirectory, 'jarvis-workspace-helper')
if (!existsSync(helper)) {
  run('/usr/bin/swift', [
    'build',
    '--package-path',
    packagePath,
    '--configuration',
    'debug',
    '--arch',
    swiftArch,
    '--product',
    'jarvis-workspace-helper'
  ])
}
const helperInfo = lstatSync(helper)
assert.equal(helperInfo.isFile(), true)
assert.equal(helperInfo.isSymbolicLink(), false)
assert.notEqual(helperInfo.mode & 0o111, 0)

function identity(path) {
  const info = lstatSync(path, { bigint: true })
  return { dev: info.dev, ino: info.ino }
}

function fixture(testRoot, name) {
  const root = join(testRoot, name, 'workspace')
  const sub = join(root, 'sub')
  mkdirSync(sub, { recursive: true })
  return { root, sub }
}

function helperInvocation({
  root,
  relativePath,
  kind,
  oldContent = Buffer.alloc(0),
  newContent = Buffer.alloc(0),
  rootIdentity = identity(root),
  parentIdentity = identity(join(root, dirname(relativePath))),
  targetIdentity = { dev: 0n, ino: 0n },
  oldLength = oldContent.byteLength,
  newLength = newContent.byteLength,
  mode = 0o600,
  input = Buffer.concat([oldContent, newContent])
}) {
  return {
    args: [
      'write',
      root,
      relativePath,
      rootIdentity.dev.toString(),
      rootIdentity.ino.toString(),
      parentIdentity.dev.toString(),
      parentIdentity.ino.toString(),
      kind,
      targetIdentity.dev.toString(),
      targetIdentity.ino.toString(),
      oldLength.toString(),
      newLength.toString(),
      mode.toString()
    ],
    input
  }
}

function invoke(options) {
  const invocation = helperInvocation(options)
  return spawnSync(helper, invocation.args, {
    cwd: repoRoot,
    input: invocation.input,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: { LANG: 'C', PATH: '/usr/bin:/bin' }
  })
}

function expectSuccess(result, bytes) {
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, bytes })
  assert.equal(result.stderr, '')
}

function expectFailure(result, message = null) {
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.notEqual(result.status, 0, 'helper unexpectedly succeeded')
  if (message) assert.match(result.stderr, message)
  assert.equal(result.stdout, '')
}

const testRoot = mkdtempSync(join(tmpdir(), 'jarvis-workspace-helper-'))
let completed = 0

async function test(name, callback) {
  await callback()
  completed += 1
  console.log(`PASS ${name}`)
}

try {
  await test('adds and updates exact UTF-8 files while preserving mode', () => {
    const { root, sub } = fixture(testRoot, 'success')
    const target = join(sub, 'note.txt')
    const initial = Buffer.from('Good morning, Jarvis.\n')
    expectSuccess(
      invoke({ root, relativePath: 'sub/note.txt', kind: 'add', newContent: initial }),
      initial.byteLength
    )
    assert.deepEqual(readFileSync(target), initial)
    assert.equal(lstatSync(target).mode & 0o777, 0o600)

    chmodSync(target, 0o640)
    const replacement = Buffer.from('Calendar checked.\n')
    expectSuccess(
      invoke({
        root,
        relativePath: 'sub/note.txt',
        kind: 'update',
        oldContent: initial,
        newContent: replacement,
        targetIdentity: identity(target),
        mode: 0o640
      }),
      replacement.byteLength
    )
    assert.deepEqual(readFileSync(target), replacement)
    assert.equal(lstatSync(target).mode & 0o777, 0o640)
  })

  await test('accepts the exact content ceiling and rejects one byte over it', () => {
    const { root, sub } = fixture(testRoot, 'bounds')
    const maximum = Buffer.alloc(192 * 1024, 0x61)
    expectSuccess(
      invoke({ root, relativePath: 'sub/maximum.txt', kind: 'add', newContent: maximum }),
      maximum.byteLength
    )
    assert.equal(readFileSync(join(sub, 'maximum.txt')).byteLength, maximum.byteLength)

    const rejected = invoke({
      root,
      relativePath: 'sub/too-large.txt',
      kind: 'add',
      newLength: maximum.byteLength + 1,
      input: Buffer.alloc(0)
    })
    expectFailure(rejected, /bounded protocol/u)
    assert.equal(existsSync(join(sub, 'too-large.txt')), false)

    const parentSegments = Array.from({ length: 128 }, (_value, index) => `d${index}`)
    const deepParent = join(root, ...parentSegments)
    mkdirSync(deepParent, { recursive: true })
    const deepRelative = `${parentSegments.join('/')}/too-deep.txt`
    expectFailure(
      invoke({
        root,
        relativePath: deepRelative,
        kind: 'add',
        newContent: Buffer.from('x'),
        parentIdentity: identity(deepParent)
      }),
      /parent path is invalid/u
    )
    assert.equal(existsSync(join(deepParent, 'too-deep.txt')), false)
  })

  await test('rejects stale root, parent, target, and preimage bindings', () => {
    const { root, sub } = fixture(testRoot, 'stale')
    const target = join(sub, 'state.txt')
    const contents = Buffer.from('before')
    writeFileSync(target, contents, { mode: 0o600 })
    const rootId = identity(root)
    const parentId = identity(sub)
    const targetId = identity(target)

    expectFailure(
      invoke({
        root,
        relativePath: 'sub/new.txt',
        kind: 'add',
        newContent: Buffer.from('new'),
        rootIdentity: { ...rootId, ino: rootId.ino + 1n }
      }),
      /root identity changed/u
    )
    expectFailure(
      invoke({
        root,
        relativePath: 'sub/new.txt',
        kind: 'add',
        newContent: Buffer.from('new'),
        parentIdentity: { ...parentId, ino: parentId.ino + 1n }
      }),
      /parent identity changed/u
    )
    expectFailure(
      invoke({
        root,
        relativePath: 'sub/state.txt',
        kind: 'update',
        oldContent: contents,
        newContent: Buffer.from('after!'),
        targetIdentity: { ...targetId, ino: targetId.ino + 1n }
      }),
      /file identity changed/u
    )
    expectFailure(
      invoke({
        root,
        relativePath: 'sub/state.txt',
        kind: 'update',
        oldContent: Buffer.from('beforz'),
        newContent: Buffer.from('after!'),
        targetIdentity: targetId
      }),
      /file content changed/u
    )
    assert.deepEqual(readFileSync(target), contents)
    assert.equal(existsSync(join(sub, 'new.txt')), false)
  })

  await test('rejects symlink parents, symlink targets, and hardlinked targets', () => {
    const { root, sub } = fixture(testRoot, 'links')
    const outside = join(testRoot, 'links', 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(root, 'linked-parent'), 'dir')
    expectFailure(
      invoke({
        root,
        relativePath: 'linked-parent/escape.txt',
        kind: 'add',
        newContent: Buffer.from('escape'),
        parentIdentity: identity(outside)
      }),
      /physical directory/u
    )
    assert.equal(existsSync(join(outside, 'escape.txt')), false)

    const outsideTarget = join(outside, 'outside.txt')
    writeFileSync(outsideTarget, 'outside', { mode: 0o600 })
    const linkedTarget = join(sub, 'linked-target.txt')
    symlinkSync(outsideTarget, linkedTarget)
    expectFailure(
      invoke({
        root,
        relativePath: 'sub/linked-target.txt',
        kind: 'update',
        oldContent: Buffer.from('outside'),
        newContent: Buffer.from('changed'),
        targetIdentity: identity(outsideTarget)
      }),
      /exact approved workspace file/u
    )
    assert.equal(readFileSync(outsideTarget, 'utf8'), 'outside')

    const hardlinkedTarget = join(sub, 'hardlinked.txt')
    const hardlinkAlias = join(sub, 'hardlinked-alias.txt')
    writeFileSync(hardlinkedTarget, 'one', { mode: 0o600 })
    linkSync(hardlinkedTarget, hardlinkAlias)
    expectFailure(
      invoke({
        root,
        relativePath: 'sub/hardlinked.txt',
        kind: 'update',
        oldContent: Buffer.from('one'),
        newContent: Buffer.from('two'),
        targetIdentity: identity(hardlinkedTarget)
      }),
      /file identity changed/u
    )
    assert.equal(readFileSync(hardlinkedTarget, 'utf8'), 'one')
    assert.equal(readFileSync(hardlinkAlias, 'utf8'), 'one')
  })

  await test('rejects traversal, absolute paths, and redirected parent names', async () => {
    const { root, sub } = fixture(testRoot, 'redirect')
    const outsideTarget = join(testRoot, 'redirect', 'outside.txt')
    writeFileSync(outsideTarget, 'sentinel', { mode: 0o600 })
    for (const relativePath of ['../outside.txt', 'sub/../../outside.txt', '/tmp/jarvis.txt']) {
      expectFailure(
        invoke({
          root,
          relativePath,
          kind: 'add',
          newContent: Buffer.from('redirected'),
          parentIdentity: identity(root)
        }),
        /path is invalid/u
      )
    }
    assert.equal(readFileSync(outsideTarget, 'utf8'), 'sentinel')

    const parentIdentity = identity(sub)
    const invocation = helperInvocation({
      root,
      relativePath: 'sub/redirected.txt',
      kind: 'add',
      newContent: Buffer.from('ab'),
      parentIdentity
    })
    const child = spawn(helper, invocation.args, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { LANG: 'C', PATH: '/usr/bin:/bin' }
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.stdin.write(invocation.input.subarray(0, 1))
    const oldSub = join(root, 'sub-old')
    renameSync(sub, oldSub)
    mkdirSync(sub)
    child.stdin.end(invocation.input.subarray(1))
    const result = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectPromise(new Error('redirected-parent helper test timed out'))
      }, 10_000)
      child.once('error', rejectPromise)
      child.once('exit', (status, signal) => {
        clearTimeout(timer)
        resolvePromise({
          error: undefined,
          signal,
          status,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8')
        })
      })
    })
    expectFailure(result, /parent identity changed/u)
    assert.equal(existsSync(join(sub, 'redirected.txt')), false)
    assert.equal(existsSync(join(oldSub, 'redirected.txt')), false)
  })

  await test('rejects short, trailing, and malformed protocol input before mutation', () => {
    const { root, sub } = fixture(testRoot, 'protocol')
    expectFailure(
      invoke({
        root,
        relativePath: 'sub/short.txt',
        kind: 'add',
        newLength: 2,
        input: Buffer.from('a')
      }),
      /ended early/u
    )
    expectFailure(
      invoke({
        root,
        relativePath: 'sub/trailing.txt',
        kind: 'add',
        newContent: Buffer.from('a'),
        input: Buffer.from('ab')
      }),
      /trailing bytes/u
    )
    const malformed = helperInvocation({
      root,
      relativePath: 'sub/malformed.txt',
      kind: 'add',
      newContent: Buffer.from('a')
    })
    malformed.args[3] = `+${malformed.args[3]}`
    const malformedResult = spawnSync(helper, malformed.args, {
      input: malformed.input,
      encoding: 'utf8',
      timeout: 10_000,
      env: { LANG: 'C', PATH: '/usr/bin:/bin' }
    })
    expectFailure(malformedResult, /root device is invalid/u)
    expectFailure(
      invoke({
        root,
        relativePath: 'sub/nonzero-add-identity.txt',
        kind: 'add',
        newContent: Buffer.from('a'),
        targetIdentity: { dev: 1n, ino: 1n }
      }),
      /bounded protocol/u
    )
    for (const name of ['short.txt', 'trailing.txt', 'malformed.txt', 'nonzero-add-identity.txt']) {
      assert.equal(existsSync(join(sub, name)), false)
    }
  })

  console.log(`jarvis-workspace-helper integration: ${completed} groups passed`)
} finally {
  rmSync(testRoot, { recursive: true, force: true })
}
