/**
 * useConnectors — renderer hook over the window.jarvis.connectors bridge.
 * Loads cards on mount, subscribes to main-process pushes, and exposes
 * connect actions with per-slug busy state.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectorCard } from '../../../../shared/types'

export interface UseConnectorsResult {
  cards: ConnectorCard[]
  loading: boolean
  refreshing: boolean
  /** slug currently mid connect/disconnect, else null */
  busySlug: string | null
  error: string | null
  connect: (slug: string) => Promise<void>
  refresh: () => Promise<void>
}

export function useConnectors(): UseConnectorsResult {
  const [cards, setCards] = useState<ConnectorCard[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    if (!window.jarvis) {
      // non-preload context (plain browser preview)
      if (mounted.current) setLoading(false)
      return
    }
    setRefreshing(true)
    try {
      setError(null)
      const next = await window.jarvis.connectors.list()
      if (mounted.current) setCards(next)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    const loadTimer = window.setTimeout(() => void refresh(), 0)
    const unsubscribe = window.jarvis
      ? window.jarvis.connectors.onChanged((next) => {
          if (mounted.current) setCards(next)
        })
      : null
    return () => {
      window.clearTimeout(loadTimer)
      mounted.current = false
      unsubscribe?.()
    }
  }, [refresh])

  const connect = useCallback(async (slug: string): Promise<void> => {
    setBusySlug(slug)
    setError(null)
    try {
      const card = await window.jarvis.connectors.connect(slug)
      if (mounted.current) {
        setCards((prev) => prev.map((c) => (c.slug === card.slug ? card : c)))
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setBusySlug(null)
    }
  }, [])

  return {
    cards,
    loading,
    refreshing,
    busySlug,
    error,
    connect,
    refresh
  }
}
