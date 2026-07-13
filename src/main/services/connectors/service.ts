/**
 * ConnectorService — Composio connector cards + connect/disconnect flows.
 *
 * Every method degrades gracefully with no Composio key: cards render as
 * not_configured with helpful detail text and nothing throws across IPC.
 *
 * Connect flow (research: composio-connectors.md — link(), NOT the retired
 * initiate(), for Composio-managed OAuth):
 *   link(userId, authConfigId) -> shell.openExternal(redirectUrl)
 *   -> waitForConnection(180s) -> ACTIVE -> card flips to connected.
 */
import { shell } from 'electron'
import type { ConnectorCard, ConnectorStatus } from '../../../shared/types'
import { getAuthConfigId, getComposio, getUserId, hasComposioKey } from './composioClient'

const WAIT_FOR_CONNECTION_MS = 180_000

export const KEY_MISSING_DETAIL =
  'Composio API key missing — set COMPOSIO_API_KEY or add connectors.json (see docs/CONNECTORS.md)'

interface ManagedConnector {
  slug: string
  title: string
  /** shown when the API key exists but no auth config id is set for this toolkit */
  setupHint: string
}

const MANAGED: ManagedConnector[] = [
  {
    slug: 'GMAIL',
    title: 'Gmail',
    setupHint: 'Needs one-time setup — create the managed Gmail auth config (docs/CONNECTORS.md §3)'
  },
  {
    slug: 'GOOGLECALENDAR',
    title: 'Google Calendar',
    setupHint:
      'Needs one-time setup — Google Cloud OAuth client + auth config (docs/CONNECTORS.md §4)'
  },
  {
    slug: 'GITHUB',
    title: 'GitHub',
    setupHint: 'Optional — create a GitHub auth config in Composio to enable'
  },
  {
    slug: 'NOTION',
    title: 'Notion',
    setupHint: 'Optional — create a Notion auth config in Composio to enable'
  }
]

// ---------- change push ----------

type CardsListener = (cards: ConnectorCard[]) => void
const listeners = new Set<CardsListener>()
let lastCards: ConnectorCard[] = MANAGED.map((m) => baseCard(m, 'not_configured', undefined))

export function onCardsChanged(listener: CardsListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(cards: ConnectorCard[]): void {
  lastCards = cards
  for (const listener of listeners) {
    try {
      listener(cards)
    } catch {
      // a broken listener never takes the service down
    }
  }
}

/** Replace one card in the last-known list and push the whole list. */
function emitCard(card: ConnectorCard): void {
  const next = lastCards.map((c) => (c.slug === card.slug ? card : c))
  emit(next.some((c) => c.slug === card.slug) ? next : [...next, card])
}

// ---------- helpers ----------

function baseCard(
  managed: ManagedConnector,
  status: ConnectorStatus,
  detail: string | undefined
): ConnectorCard {
  return { slug: managed.slug, title: managed.title, section: 'composio', status, detail }
}

function managedFor(slug: string): ManagedConnector {
  return (
    MANAGED.find((m) => m.slug === slug.toUpperCase()) ?? {
      slug: slug.toUpperCase(),
      title: slug,
      setupHint: 'No auth config id set for this toolkit (see docs/CONNECTORS.md)'
    }
  )
}

/** Shallow-ish search for an email-looking string in connected-account state. */
function extractEmail(value: unknown, depth = 0): string | null {
  if (depth > 3 || value === null || typeof value !== 'object') return null
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof v === 'string' &&
      /email|account|user/i.test(key) &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
    ) {
      return v
    }
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    const found = extractEmail(v, depth + 1)
    if (found) return found
  }
  return null
}

interface AccountLike {
  id: string
  status: string
  statusReason?: string | null
  state?: unknown
  data?: unknown
}

async function listAccounts(slug: string): Promise<AccountLike[]> {
  const composio = await getComposio()
  const authConfigId = getAuthConfigId(slug)
  if (!composio || !authConfigId) return []
  const response = await composio.connectedAccounts.list({
    userIds: [getUserId()],
    authConfigIds: [authConfigId]
  })
  return (response.items ?? []) as unknown as AccountLike[]
}

function cardFromAccounts(managed: ManagedConnector, accounts: AccountLike[]): ConnectorCard {
  const active = accounts.find((a) => a.status === 'ACTIVE')
  if (active) {
    const email = extractEmail(active.state) ?? extractEmail(active.data)
    return baseCard(managed, 'connected', email ?? 'Connected')
  }
  const pending = accounts.find((a) => a.status === 'INITIATED' || a.status === 'INITIALIZING')
  if (pending) return baseCard(managed, 'connecting', 'Waiting for sign-in in your browser')
  const failed = accounts.find((a) => a.status === 'FAILED')
  if (failed) return baseCard(managed, 'error', failed.statusReason ?? 'Connection failed — retry')
  const expired = accounts.find((a) => a.status === 'EXPIRED' || a.status === 'REVOKED')
  if (expired) return baseCard(managed, 'disconnected', 'Session expired — reconnect')
  return baseCard(managed, 'disconnected', undefined)
}

async function cardFor(managed: ManagedConnector): Promise<ConnectorCard> {
  if (!hasComposioKey()) return baseCard(managed, 'not_configured', KEY_MISSING_DETAIL)
  if (!getAuthConfigId(managed.slug)) return baseCard(managed, 'not_configured', managed.setupHint)
  try {
    return cardFromAccounts(managed, await listAccounts(managed.slug))
  } catch (error) {
    return baseCard(managed, 'error', errorMessage(error))
  }
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw
}

// ---------- public API ----------

export async function list(): Promise<ConnectorCard[]> {
  const cards = await Promise.all(MANAGED.map((m) => cardFor(m)))
  lastCards = cards
  return cards
}

export async function connect(slug: string): Promise<ConnectorCard> {
  const managed = managedFor(slug)

  if (!hasComposioKey()) {
    const card = baseCard(managed, 'not_configured', KEY_MISSING_DETAIL)
    emitCard(card)
    return card
  }
  const authConfigId = getAuthConfigId(managed.slug)
  if (!authConfigId) {
    const card = baseCard(managed, 'not_configured', managed.setupHint)
    emitCard(card)
    return card
  }

  try {
    const composio = await getComposio()
    if (!composio) {
      const card = baseCard(managed, 'not_configured', KEY_MISSING_DETAIL)
      emitCard(card)
      return card
    }

    // link() throws ComposioMultipleConnectedAccountsError when an ACTIVE
    // connection already exists — pre-check and short-circuit to connected.
    const existing = await listAccounts(managed.slug)
    const alreadyActive = existing.find((a) => a.status === 'ACTIVE')
    if (alreadyActive) {
      const card = cardFromAccounts(managed, existing)
      emitCard(card)
      return card
    }

    const request = await composio.connectedAccounts.link(getUserId(), authConfigId)
    if (!request.redirectUrl) {
      const card = baseCard(managed, 'error', 'Composio returned no redirect URL')
      emitCard(card)
      return card
    }

    await shell.openExternal(request.redirectUrl)
    emitCard(baseCard(managed, 'connecting', 'Complete the sign-in in your browser'))

    const account = (await composio.connectedAccounts.waitForConnection(
      request.id,
      WAIT_FOR_CONNECTION_MS
    )) as unknown as AccountLike
    const email = extractEmail(account.state) ?? extractEmail(account.data)
    const card = baseCard(managed, 'connected', email ?? 'Connected')
    emitCard(card)
    return card
  } catch (error) {
    const message = errorMessage(error)
    // Race with the pre-check: an ACTIVE account appeared between list and link.
    if (/multiple/i.test(message) && /connected/i.test(message)) {
      const card = await cardFor(managed)
      emitCard(card)
      return card
    }
    const timedOut = /timeout|timed out/i.test(message)
    const card = baseCard(
      managed,
      timedOut ? 'disconnected' : 'error',
      timedOut ? 'Timed out waiting for sign-in — try again' : message
    )
    emitCard(card)
    return card
  }
}

export async function disconnect(slug: string): Promise<ConnectorCard> {
  const managed = managedFor(slug)

  if (!hasComposioKey()) {
    const card = baseCard(managed, 'not_configured', KEY_MISSING_DETAIL)
    emitCard(card)
    return card
  }
  if (!getAuthConfigId(managed.slug)) {
    const card = baseCard(managed, 'not_configured', managed.setupHint)
    emitCard(card)
    return card
  }

  try {
    const composio = await getComposio()
    if (!composio) {
      const card = baseCard(managed, 'not_configured', KEY_MISSING_DETAIL)
      emitCard(card)
      return card
    }
    const accounts = await listAccounts(managed.slug)
    for (const account of accounts) {
      if (
        account.status === 'ACTIVE' ||
        account.status === 'INITIATED' ||
        account.status === 'EXPIRED'
      ) {
        await composio.connectedAccounts.delete(account.id)
      }
    }
    const card = baseCard(managed, 'disconnected', undefined)
    emitCard(card)
    return card
  } catch (error) {
    const card = baseCard(managed, 'error', errorMessage(error))
    emitCard(card)
    return card
  }
}

/** Recompute all cards and push to listeners (used after config changes). */
export async function refresh(): Promise<ConnectorCard[]> {
  const cards = await list()
  emit(cards)
  return cards
}
