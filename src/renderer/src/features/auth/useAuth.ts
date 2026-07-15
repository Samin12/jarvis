import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthStatus } from '../../../../shared/types'

export interface UseAuth {
  status: AuthStatus
  /** True while main is running the browser OAuth flow. */
  authorizing: boolean
  signIn: () => Promise<void>
  cancelSignIn: () => Promise<void>
  signOut: () => Promise<void>
}

/**
 * Auth state + actions over window.jarvis.auth. Status stays live via the
 * auth:status-changed push channel; signIn also resolves with the final status.
 */
export function useAuth(): UseAuth {
  const [status, setStatus] = useState<AuthStatus>({ state: 'checking' })
  const authEpoch = useRef(0)

  useEffect(() => {
    if (!window.jarvis) return undefined // non-preload context (plain browser preview)
    let mounted = true
    window.jarvis.auth
      .getStatus()
      .then((s) => {
        if (mounted) setStatus(s)
      })
      .catch(() => setStatus({ state: 'error', message: 'The local Jarvis core did not respond.' }))
    const unsubscribe = window.jarvis.auth.onStatusChanged((s) => setStatus(s))
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const signIn = useCallback(async () => {
    if (!window.jarvis) return
    const epoch = ++authEpoch.current
    setStatus({ state: 'authorizing', phase: 'opening_browser' })
    try {
      const final = await window.jarvis.auth.signIn()
      if (epoch === authEpoch.current) setStatus(final)
    } catch (error) {
      if (epoch === authEpoch.current) {
        setStatus({
          state: 'error',
          message: error instanceof Error ? error.message : 'ChatGPT sign-in could not start.'
        })
      }
    }
  }, [])

  const cancelSignIn = useCallback(async () => {
    if (!window.jarvis) return
    authEpoch.current += 1
    try {
      await window.jarvis.auth.cancelSignIn()
      setStatus({ state: 'signed_out' })
    } catch (error) {
      setStatus({
        state: 'error',
        message: error instanceof Error ? error.message : 'ChatGPT sign-in could not be cancelled.'
      })
    }
  }, [])

  const signOut = useCallback(async () => {
    if (!window.jarvis) return
    await window.jarvis.auth.signOut()
    setStatus({ state: 'signed_out' })
  }, [])

  return { status, authorizing: status.state === 'authorizing', signIn, cancelSignIn, signOut }
}
