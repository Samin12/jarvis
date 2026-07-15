import { spawnSync } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JarvisAppServer } from '../../src/main/services/appServer/client'
import {
  buildMinimalChildEnvironment,
  prepareIsolatedCodexHome
} from '../../src/main/services/appServer/environment'
import {
  resolveBundledCodexExecutable,
  verifyCodexExecutableVersion,
  type ResolvedCodexExecutable
} from '../../src/main/services/appServer/executable'
import {
  JARVIS_ASSISTANT_PERMISSION_PROFILE,
  JARVIS_CODEX_CONFIG_TOML,
  JARVIS_TASK_PERMISSION_PROFILE
} from '../../src/main/services/appServer/permissions'
import {
  CODEX_PROTOCOL_SCHEMA_SHA256,
  CODEX_PROTOCOL_VERSION,
  type DynamicToolCallParams,
  type JsonValue,
  type NotificationMap
} from '../../src/main/services/appServer/protocol'
import {
  CODEX_TASK_TOOL_NAMESPACE,
  DISPATCH_CODEX_TASK_DYNAMIC_TOOL,
  validateAssistantCodexToolCall
} from '../../src/main/services/tasks/assistantTool'

describe('pinned Codex app-server contract', () => {
  it('installs an exact private permission profile configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-permission-config-'))
    try {
      const codexHome = await prepareIsolatedCodexHome(join(root, 'codex-home'))
      const configPath = join(codexHome, 'config.toml')
      expect(await readFile(configPath, 'utf8')).toBe(JARVIS_CODEX_CONFIG_TOML)
      if (process.platform !== 'win32') {
        expect((await stat(configPath)).mode & 0o777).toBe(0o600)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'proves the vendored sandbox denies ambient task workspace and credential reads',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'jarvis-permission-probe-'))
      try {
        const codexHome = await prepareIsolatedCodexHome(join(root, 'codex-home'))
        const assistantScratch = join(root, 'assistant-scratch')
        const workspace = join(root, 'workspace')
        const outside = join(root, 'outside-secret')
        await Promise.all([mkdir(assistantScratch), mkdir(workspace)])
        const authPath = join(codexHome, 'auth.json')
        const workspacePath = join(workspace, 'visible.txt')
        const writeProbe = join(workspace, 'must-not-exist.txt')
        await Promise.all([
          writeFile(authPath, 'credential sentinel', { mode: 0o600 }),
          writeFile(workspacePath, 'workspace sentinel'),
          writeFile(outside, 'outside sentinel')
        ])

        const executable = await resolveBundledCodexExecutable({
          isPackaged: false,
          appRoot: process.cwd(),
          platform: process.platform,
          arch: process.arch
        })
        const env = buildMinimalChildEnvironment(codexHome)
        const assistant = spawnSync(
          executable.path,
          [
            'sandbox',
            '-P',
            JARVIS_ASSISTANT_PERMISSION_PROFILE,
            '-C',
            assistantScratch,
            '/bin/sh',
            '-c',
            'test ! -r "$1" && test ! -r "$2"',
            'jarvis-probe',
            authPath,
            outside
          ],
          { env, encoding: 'utf8' }
        )
        expect(assistant.status, assistant.stderr).toBe(0)

        const task = spawnSync(
          executable.path,
          [
            'sandbox',
            '-P',
            JARVIS_TASK_PERMISSION_PROFILE,
            '-C',
            workspace,
            '/bin/sh',
            '-c',
            'test ! -r "$1" && test ! -r "$2" && test ! -r "$3" && ! /usr/bin/touch "$4" 2>/dev/null',
            'jarvis-probe',
            workspacePath,
            outside,
            authPath,
            writeProbe
          ],
          { env, encoding: 'utf8' }
        )
        expect(task.status, task.stderr).toBe(0)
        await expect(stat(writeProbe)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('rejects a symlinked isolated home without changing the target permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-home-boundary-'))
    const target = join(root, 'target')
    const link = join(root, 'codex-home')

    try {
      await mkdir(target, { mode: 0o750 })
      await symlink(target, link)
      const before = (await stat(target)).mode & 0o777

      await expect(prepareIsolatedCodexHome(link)).rejects.toThrow(/must not be a symlink/)
      expect((await stat(target)).mode & 0o777).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('starts the real bundled binary in a fresh profile and reads signed-out account state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-real-app-server-'))
    const executable = await resolveBundledCodexExecutable({
      isPackaged: false,
      appRoot: process.cwd(),
      platform: process.platform,
      arch: process.arch
    })
    const codexHome = join(root, 'codex-home')
    const client = new JarvisAppServer({
      executable,
      codexHome,
      client: { name: 'jarvis-contract-test', title: 'Jarvis Contract Test', version: '0.0.0' }
    })

    try {
      await prepareIsolatedCodexHome(codexHome)
      await verifyCodexExecutableVersion(executable, { codexHome })
      const ready = await client.start()
      expect(ready.userAgent).toMatch(
        new RegExp(`\\b${CODEX_PROTOCOL_VERSION.replaceAll('.', '\\.')}\\b`)
      )
      const account = await client.request('account/read', {})
      expect(account.account).toBeNull()
      expect(account.requiresOpenaiAuth).toBe(true)
    } finally {
      await client.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('correlates requests and routes approval requests through a typed host handler', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-fake-app-server-'))
    const fakePath = join(root, 'fake-codex')
    const codexHome = join(root, 'codex-home')
    const fakeSource = `#!${process.execPath}
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex/0.144.3', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' } })
  } else if (message.method === 'initialized') {
    send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', startedAtMs: 1, environmentId: null, command: 'pwd', cwd: process.env.CODEX_HOME } })
  } else if (message.id === 'approval-1') {
    send({ method: 'account/login/completed', params: { loginId: message.result.decision, success: true, error: null } })
  } else if (message.method === 'account/read') {
    send({ id: message.id, result: { account: { type: 'chatgpt', email: 'test@example.com', planType: 'plus' }, requiresOpenaiAuth: true } })
  }
})
`
    await writeFile(fakePath, fakeSource, { mode: 0o700 })
    await chmod(fakePath, 0o700)

    const executable: ResolvedCodexExecutable = {
      path: fakePath,
      sha256: '0'.repeat(64),
      protocolVersion: CODEX_PROTOCOL_VERSION,
      protocolSchemaSha256: CODEX_PROTOCOL_SCHEMA_SHA256,
      platformPackage: '@openai/codex-test',
      platformPackageVersion: `${CODEX_PROTOCOL_VERSION}-test`,
      targetTriple: 'test',
      source: 'development'
    }
    let reviewedCommand = ''
    const client = new JarvisAppServer({
      executable,
      codexHome,
      client: { name: 'jarvis-test', title: 'Jarvis Test', version: '0.0.0' },
      verifyExecutableOnStart: false,
      handlers: {
        'item/commandExecution/requestApproval': (params) => {
          reviewedCommand = params.command ?? ''
          return { decision: 'decline' }
        }
      }
    })
    const approvalObserved = new Promise<string>((resolveNotification) => {
      client.subscribe('account/login/completed', ({ params }) => {
        resolveNotification(params.loginId ?? '')
      })
    })

    try {
      const ready = await client.start()
      expect(ready.codexHome).toBe(await realpath(codexHome))
      expect(await client.request('account/read', {})).toMatchObject({
        account: { type: 'chatgpt', email: 'test@example.com', planType: 'plus' }
      })
      expect(await approvalObserved).toBe('decline')
      expect(reviewedCommand).toBe('pwd')
    } finally {
      await client.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('aborts only the approval RPC named by serverRequest/resolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-resolved-app-server-'))
    const fakePath = join(root, 'fake-codex')
    const codexHome = join(root, 'codex-home')
    const fakeSource = `#!${process.execPath}
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex/0.144.3', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' } })
  } else if (message.method === 'initialized') {
    const base = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', startedAtMs: 1, environmentId: null, command: 'cat note.txt', cwd: process.env.CODEX_HOME, commandActions: [{ type: 'read', command: 'cat note.txt', name: 'note.txt', path: process.env.CODEX_HOME }] }
    send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: base })
    send({ id: 'approval-2', method: 'item/commandExecution/requestApproval', params: { ...base, approvalId: 'callback-2' } })
  } else if (message.id === 'approval-2') {
    send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'approval-1' } })
    setTimeout(() => send({ method: 'account/login/completed', params: { loginId: 'resolved', success: true, error: null } }), 25)
  } else if (message.id === 'approval-1') {
    send({ method: 'account/login/completed', params: { loginId: 'unexpected-response', success: false, error: null } })
  }
})
`
    await writeFile(fakePath, fakeSource, { mode: 0o700 })
    await chmod(fakePath, 0o700)

    const executable: ResolvedCodexExecutable = {
      path: fakePath,
      sha256: '0'.repeat(64),
      protocolVersion: CODEX_PROTOCOL_VERSION,
      protocolSchemaSha256: CODEX_PROTOCOL_SCHEMA_SHA256,
      platformPackage: '@openai/codex-test',
      platformPackageVersion: `${CODEX_PROTOCOL_VERSION}-test`,
      targetTriple: 'test',
      source: 'development'
    }
    const aborted = new Set<string>()
    const signals = new Map<string, AbortSignal>()
    const client = new JarvisAppServer({
      executable,
      codexHome,
      client: { name: 'jarvis-test', title: 'Jarvis Test', version: '0.0.0' },
      verifyExecutableOnStart: false,
      handlers: {
        'item/commandExecution/requestApproval': (_params, context) => {
          const requestId = String(context.requestId)
          signals.set(requestId, context.signal)
          if (requestId === 'approval-2') return { decision: 'decline' }
          return new Promise((resolveApproval) => {
            context.signal.addEventListener(
              'abort',
              () => {
                aborted.add(requestId)
                resolveApproval({ decision: 'decline' })
              },
              { once: true }
            )
          })
        }
      }
    })
    const completion = new Promise<string>((resolveNotification) => {
      client.subscribe('account/login/completed', ({ params }) => {
        resolveNotification(params.loginId ?? '')
      })
    })

    try {
      await client.start()
      expect(await completion).toBe('resolved')
      expect(aborted).toEqual(new Set(['approval-1']))
      expect(signals.get('approval-2')?.aborted).toBe(false)
    } finally {
      await client.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses the exact pinned dynamicTools and item/tool/call wire shapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-dynamic-tool-app-server-'))
    const fakePath = join(root, 'fake-codex')
    const codexHome = join(root, 'codex-home')
    const fakeSource = `#!${process.execPath}
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex/0.144.3', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' } })
  } else if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread-dynamic' } } })
    send({ method: 'thread/realtime/itemAdded', params: { threadId: 'thread-dynamic', item: { dynamicTools: message.params.dynamicTools } } })
    send({ id: 'dynamic-call-1', method: 'item/tool/call', params: { threadId: 'thread-dynamic', turnId: 'turn-1', callId: 'call-1', namespace: 'tickets', tool: 'lookup_ticket', arguments: { id: 'ABC-123' } } })
  } else if (message.id === 'dynamic-call-1') {
    send({ method: 'thread/realtime/itemAdded', params: { threadId: 'thread-dynamic', item: { response: message.result } } })
  }
})
`
    await writeFile(fakePath, fakeSource, { mode: 0o700 })
    await chmod(fakePath, 0o700)

    const executable: ResolvedCodexExecutable = {
      path: fakePath,
      sha256: '0'.repeat(64),
      protocolVersion: CODEX_PROTOCOL_VERSION,
      protocolSchemaSha256: CODEX_PROTOCOL_SCHEMA_SHA256,
      platformPackage: '@openai/codex-test',
      platformPackageVersion: `${CODEX_PROTOCOL_VERSION}-test`,
      targetTriple: 'test',
      source: 'development'
    }
    let handledParams: DynamicToolCallParams | null = null
    let handledSignalWasAborted: boolean | null = null
    const client = new JarvisAppServer({
      executable,
      codexHome,
      client: { name: 'jarvis-test', title: 'Jarvis Test', version: '0.0.0' },
      verifyExecutableOnStart: false,
      handlers: {
        'item/tool/call': (params, context) => {
          handledParams = params
          handledSignalWasAborted = context.signal.aborted
          return {
            contentItems: [{ type: 'inputText', text: 'Ticket ABC-123 is open.' }],
            success: true
          }
        }
      }
    })
    const observations = new Promise<JsonValue[]>((resolveObservations) => {
      const seen: JsonValue[] = []
      client.subscribe('thread/realtime/itemAdded', ({ params }) => {
        seen.push(params.item)
        if (seen.length === 2) resolveObservations(seen)
      })
    })

    try {
      await client.start()
      await client.request('thread/start', {
        cwd: '/tmp/jarvis-dynamic',
        dynamicTools: [
          {
            type: 'function',
            name: 'jarvis_status',
            description: 'Read Jarvis status',
            inputSchema: { type: 'object', additionalProperties: false }
          },
          {
            type: 'namespace',
            name: 'tickets',
            description: 'Ticket management tools',
            tools: [
              {
                type: 'function',
                name: 'lookup_ticket',
                description: 'Fetch a ticket by id',
                deferLoading: true,
                inputSchema: {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                  required: ['id']
                }
              }
            ]
          }
        ]
      })

      expect(await observations).toEqual([
        {
          dynamicTools: [
            {
              type: 'function',
              name: 'jarvis_status',
              description: 'Read Jarvis status',
              inputSchema: { type: 'object', additionalProperties: false }
            },
            {
              type: 'namespace',
              name: 'tickets',
              description: 'Ticket management tools',
              tools: [
                {
                  type: 'function',
                  name: 'lookup_ticket',
                  description: 'Fetch a ticket by id',
                  deferLoading: true,
                  inputSchema: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                    required: ['id']
                  }
                }
              ]
            }
          ]
        },
        {
          response: {
            contentItems: [{ type: 'inputText', text: 'Ticket ABC-123 is open.' }],
            success: true
          }
        }
      ])
      expect(handledParams).toEqual({
        threadId: 'thread-dynamic',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: 'tickets',
        tool: 'lookup_ticket',
        arguments: { id: 'ABC-123' }
      })
      expect(handledSignalWasAborted).toBe(false)
    } finally {
      await client.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('carries the path-free assistant Codex dispatch contract over the pinned wire', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-assistant-codex-tool-'))
    const fakePath = join(root, 'fake-codex')
    const codexHome = join(root, 'codex-home')
    const fakeSource = `#!${process.execPath}
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex/0.144.3', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' } })
  } else if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'assistant-thread' } } })
    send({ method: 'thread/realtime/itemAdded', params: { threadId: 'assistant-thread', item: { dynamicTools: message.params.dynamicTools } } })
    send({ id: 'dispatch-rpc', method: 'item/tool/call', params: { threadId: 'assistant-thread', turnId: 'assistant-turn', callId: 'dispatch-call', namespace: 'jarvis_codex', tool: 'dispatch_task', arguments: { prompt: 'Inspect the selected project' } } })
  } else if (message.id === 'dispatch-rpc') {
    send({ method: 'thread/realtime/itemAdded', params: { threadId: 'assistant-thread', item: { response: message.result } } })
  }
})
`
    await writeFile(fakePath, fakeSource, { mode: 0o700 })
    await chmod(fakePath, 0o700)

    const executable: ResolvedCodexExecutable = {
      path: fakePath,
      sha256: '0'.repeat(64),
      protocolVersion: CODEX_PROTOCOL_VERSION,
      protocolSchemaSha256: CODEX_PROTOCOL_SCHEMA_SHA256,
      platformPackage: '@openai/codex-test',
      platformPackageVersion: `${CODEX_PROTOCOL_VERSION}-test`,
      targetTriple: 'test',
      source: 'development'
    }
    let validatedPrompt: string | null = null
    const client = new JarvisAppServer({
      executable,
      codexHome,
      client: { name: 'jarvis-test', title: 'Jarvis Test', version: '0.0.0' },
      verifyExecutableOnStart: false,
      handlers: {
        'item/tool/call': (params) => {
          const call = validateAssistantCodexToolCall(params)
          validatedPrompt = call.prompt
          return {
            contentItems: [
              {
                type: 'inputText',
                text: 'Dispatch acknowledged only; no workspace result is claimed.'
              }
            ],
            success: true
          }
        }
      }
    })
    const observations = new Promise<JsonValue[]>((resolveObservations) => {
      const seen: JsonValue[] = []
      client.subscribe('thread/realtime/itemAdded', ({ params }) => {
        seen.push(params.item)
        if (seen.length === 2) resolveObservations(seen)
      })
    })

    try {
      await client.start()
      await client.request('thread/start', {
        cwd: '/tmp/jarvis-assistant-scratch',
        dynamicTools: [
          {
            type: 'namespace',
            name: CODEX_TASK_TOOL_NAMESPACE,
            description: 'Host-owned bounded Codex dispatch.',
            tools: [
              {
                type: 'function',
                ...DISPATCH_CODEX_TASK_DYNAMIC_TOOL,
                deferLoading: false
              }
            ]
          }
        ]
      })

      const [advertised, response] = await observations
      expect(advertised).toMatchObject({
        dynamicTools: [
          {
            name: 'jarvis_codex',
            tools: [
              {
                name: 'dispatch_task',
                inputSchema: {
                  type: 'object',
                  required: ['prompt'],
                  additionalProperties: false,
                  properties: { prompt: { type: 'string' } }
                }
              }
            ]
          }
        ]
      })
      const serialized = JSON.stringify(advertised)
      expect(serialized).not.toMatch(/scopeId|workspacePath|"path"/u)
      expect(validatedPrompt).toBe('Inspect the selected project')
      expect(response).toEqual({
        response: {
          contentItems: [
            {
              type: 'inputText',
              text: 'Dispatch acknowledged only; no workspace result is claimed.'
            }
          ],
          success: true
        }
      })
    } finally {
      await client.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails malformed and unsupported tool requests closed and responds once to duplicate ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-dynamic-tool-hardening-'))
    const fakePath = join(root, 'fake-codex')
    const codexHome = join(root, 'codex-home')
    const fakeSource = `#!${process.execPath}
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const responses = {}
const duplicate = { threadId: 'thread-1', turnId: 'turn-1', callId: 'duplicate-call', namespace: null, tool: 'status', arguments: { verbose: false } }
let duplicateResponses = 0
let summaryScheduled = false
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex/0.144.3', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' } })
  } else if (message.method === 'initialized') {
    send({ id: 'unknown-1', method: 'item/tool/notAllowlisted', params: {} })
    send({ id: 'malformed-1', method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'malformed-call', namespace: 'bad namespace', tool: 'lookup', arguments: {} } })
    send({ id: 'extra-keys-1', method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'extra-keys-call', namespace: null, tool: 'status', arguments: {}, unexpected: true } })
    send({ id: 'duplicate-1', method: 'item/tool/call', params: duplicate })
    send({ id: 'duplicate-1', method: 'item/tool/call', params: duplicate })
    send({ id: 'handler-error-1', method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'handler-error-call', namespace: null, tool: 'explode', arguments: {} } })
  } else if (['unknown-1', 'malformed-1', 'extra-keys-1', 'duplicate-1', 'handler-error-1'].includes(String(message.id))) {
    if (message.id === 'duplicate-1') {
      duplicateResponses += 1
      if (duplicateResponses === 1) {
        send({ id: 'duplicate-1', method: 'item/tool/call', params: duplicate })
      }
    }
    responses[message.id] = message
    if (Object.keys(responses).length === 5 && !summaryScheduled) {
      summaryScheduled = true
      setTimeout(() => send({ method: 'thread/realtime/itemAdded', params: { threadId: 'thread-1', item: { responses, duplicateResponses } } }), 50)
    }
  }
})
`
    await writeFile(fakePath, fakeSource, { mode: 0o700 })
    await chmod(fakePath, 0o700)

    const executable: ResolvedCodexExecutable = {
      path: fakePath,
      sha256: '0'.repeat(64),
      protocolVersion: CODEX_PROTOCOL_VERSION,
      protocolSchemaSha256: CODEX_PROTOCOL_SCHEMA_SHA256,
      platformPackage: '@openai/codex-test',
      platformPackageVersion: `${CODEX_PROTOCOL_VERSION}-test`,
      targetTriple: 'test',
      source: 'development'
    }
    const handlerCalls: string[] = []
    const client = new JarvisAppServer({
      executable,
      codexHome,
      client: { name: 'jarvis-test', title: 'Jarvis Test', version: '0.0.0' },
      verifyExecutableOnStart: false,
      handlers: {
        'item/tool/call': (params) => {
          handlerCalls.push(params.callId)
          if (params.callId === 'handler-error-call') throw new Error('sensitive handler failure')
          return {
            contentItems: [{ type: 'inputText', text: 'ok' }],
            success: true
          }
        }
      }
    })
    const summary = new Promise<JsonValue>((resolveSummary) => {
      client.subscribe('thread/realtime/itemAdded', ({ params }) => resolveSummary(params.item))
    })

    try {
      await client.start()
      expect(await summary).toEqual({
        responses: {
          'unknown-1': {
            id: 'unknown-1',
            error: { code: -32601, message: 'Server request method is not allowlisted' }
          },
          'malformed-1': {
            id: 'malformed-1',
            result: {
              contentItems: [
                {
                  type: 'inputText',
                  text: 'Jarvis could not safely handle this tool call.'
                }
              ],
              success: false
            }
          },
          'extra-keys-1': {
            id: 'extra-keys-1',
            result: {
              contentItems: [
                {
                  type: 'inputText',
                  text: 'Jarvis could not safely handle this tool call.'
                }
              ],
              success: false
            }
          },
          'duplicate-1': {
            id: 'duplicate-1',
            result: {
              contentItems: [{ type: 'inputText', text: 'ok' }],
              success: true
            }
          },
          'handler-error-1': {
            id: 'handler-error-1',
            result: {
              contentItems: [
                {
                  type: 'inputText',
                  text: 'Jarvis could not safely handle this tool call.'
                }
              ],
              success: false
            }
          }
        },
        duplicateResponses: 1
      })
      expect(handlerCalls).toEqual(['duplicate-call', 'handler-error-call'])
    } finally {
      await client.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses the exact pinned WebRTC start shape and correlates realtime notifications', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-realtime-app-server-'))
    const fakePath = join(root, 'fake-codex')
    const codexHome = join(root, 'codex-home')
    const fakeSource = `#!${process.execPath}
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex/0.144.3', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' } })
  } else if (message.method === 'thread/realtime/start') {
    send({ id: message.id, result: {} })
    send({ method: 'thread/realtime/started', params: { threadId: message.params.threadId, realtimeSessionId: 'backend-session', version: 'v1' } })
    send({ method: 'thread/realtime/sdp', params: { threadId: message.params.threadId, sdp: 'v=answer\\r\\n' } })
    send({ method: 'thread/realtime/itemAdded', params: { threadId: message.params.threadId, item: { captured: message.params } } })
  } else if (message.method === 'thread/realtime/stop') {
    send({ id: message.id, result: {} })
    send({ method: 'thread/realtime/closed', params: { threadId: message.params.threadId, reason: 'requested' } })
  }
})
`
    await writeFile(fakePath, fakeSource, { mode: 0o700 })
    await chmod(fakePath, 0o700)

    const executable: ResolvedCodexExecutable = {
      path: fakePath,
      sha256: '0'.repeat(64),
      protocolVersion: CODEX_PROTOCOL_VERSION,
      protocolSchemaSha256: CODEX_PROTOCOL_SCHEMA_SHA256,
      platformPackage: '@openai/codex-test',
      platformPackageVersion: `${CODEX_PROTOCOL_VERSION}-test`,
      targetTriple: 'test',
      source: 'development'
    }
    const client = new JarvisAppServer({
      executable,
      codexHome,
      client: { name: 'jarvis-test', title: 'Jarvis Test', version: '0.0.0' },
      verifyExecutableOnStart: false
    })
    const started = new Promise<NotificationMap['thread/realtime/started']>(
      (resolveNotification) => {
        client.subscribe('thread/realtime/started', ({ params }) => resolveNotification(params))
      }
    )
    const sdp = new Promise<NotificationMap['thread/realtime/sdp']>((resolveNotification) => {
      client.subscribe('thread/realtime/sdp', ({ params }) => resolveNotification(params))
    })
    const captured = new Promise<JsonValue>((resolveNotification) => {
      client.subscribe('thread/realtime/itemAdded', ({ params }) =>
        resolveNotification(params.item)
      )
    })
    const closed = new Promise<NotificationMap['thread/realtime/closed']>((resolveNotification) => {
      client.subscribe('thread/realtime/closed', ({ params }) => resolveNotification(params))
    })

    try {
      await client.start()
      await client.request('thread/realtime/start', {
        threadId: 'thread-live',
        clientManagedHandoffs: false,
        flushTranscriptTailOnSessionEnd: true,
        codexResponsesAsItems: true,
        outputModality: 'audio',
        includeStartupContext: true,
        prompt: 'You are Jarvis.',
        transport: { type: 'webrtc', sdp: 'v=offer\r\n' }
      })
      expect(await started).toEqual({
        threadId: 'thread-live',
        realtimeSessionId: 'backend-session',
        version: 'v1'
      })
      expect(await sdp).toEqual({ threadId: 'thread-live', sdp: 'v=answer\r\n' })
      expect(await captured).toEqual({
        captured: {
          threadId: 'thread-live',
          clientManagedHandoffs: false,
          flushTranscriptTailOnSessionEnd: true,
          codexResponsesAsItems: true,
          outputModality: 'audio',
          includeStartupContext: true,
          prompt: 'You are Jarvis.',
          transport: { type: 'webrtc', sdp: 'v=offer\r\n' }
        }
      })
      await client.request('thread/realtime/stop', { threadId: 'thread-live' })
      expect(await closed).toEqual({ threadId: 'thread-live', reason: 'requested' })
    } finally {
      await client.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
