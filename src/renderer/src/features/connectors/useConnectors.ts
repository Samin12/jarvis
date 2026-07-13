/**
 * useConnectors — renderer hook over the window.jarvis.connectors bridge.
 * Loads cards on mount, subscribes to main-process pushes, and exposes
 * connect/disconnect actions with per-slug busy state.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectorCard } from '../../../../shared/types'

export interface UseConnectorsResult {
  cards: ConnectorCard[]
  loading: boolean
  /** slug currently mid connect/disconnect, else null */
  busySlug: string | null
  /** true when every card reports the Composio API key is missing */
  composioKeyMissing: boolean
  connect: (slug: string) => Promise<void>
  disconnect: (slug: string) => Promise<void>
  refresh: () => Promise<void>
}

function keyMissing(cards: ConnectorCard[]): boolean {
  return (
    cards.length > 0 &&
    cards.every(
      (card) =>
        card.status === 'not_configured' &&
        (card.detail ?? '').toLowerCase().includes('composio api key missing')
    )
  )
}

export function useConnectors(): UseConnectorsResult {
  const [cards, setCards] = useState<ConnectorCard[]>([])
  const [loading, setLoading] = useState(true)
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const mounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.jarvis.connectors.list()
      if (mounted.current) setCards(next)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const unsubscribe = window.jarvis.connectors.onChanged((next) => {
      if (mounted.current) setCards(next)
    })
    return () => {
      mounted.current = false
      unsubscribe()
    }
  }, [refresh])

  const connect = useCallback(async (slug: string): Promise<void> => {
    setBusySlug(slug)
    try {
      const card = await window.jarvis.connectors.connect(slug)
      if (mounted.current) {
        setCards((prev) => prev.map((c) => (c.slug === card.slug ? card : c)))
      }
    } finally {
      if (mounted.current) setBusySlug(null)
    }
  }, [])

  const disconnect = useCallback(async (slug: string): Promise<void> => {
    setBusySlug(slug)
    try {
      const card = await window.jarvis.connectors.disconnect(slug)
      if (mounted.current) {
        setCards((prev) => prev.map((c) => (c.slug === card.slug ? card : c)))
      }
    } finally {
      if (mounted.current) setBusySlug(null)
    }
  }, [])

  return {
    cards,
    loading,
    busySlug,
    composioKeyMissing: keyMissing(cards),
    connect,
    disconnect,
    refresh
  }
}
