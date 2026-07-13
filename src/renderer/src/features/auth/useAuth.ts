import { useCallback, useEffect, useState } from 'react'
import type { AuthStatus } from '../../../../shared/types'

export interface UseAuth {
  status: AuthStatus
  /** True while main is running the browser OAuth flow. */
  authorizing: boolean
  signIn: () => Promise<void>
  signOut: () => Promise<void>
}

/**
 * Auth state + actions over window.jarvis.auth. Status stays live via the
 * auth:status-changed push channel; signIn also resolves with the final status.
 */
export function useAuth(): UseAuth {
  const [status, setStatus] = useState<AuthStatus>({ state: 'signed_out' })

  useEffect(() => {
    let mounted = true
    window.jarvis.auth
      .getStatus()
      .then((s) => {
        if (mounted) setStatus(s)
      })
      .catch(() => {
        /* main not wired yet — stay signed_out */
      })
    const unsubscribe = window.jarvis.auth.onStatusChanged((s) => setStatus(s))
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const signIn = useCallback(async () => {
    setStatus({ state: 'authorizing' })
    const final = await window.jarvis.auth.signIn()
    setStatus(final)
  }, [])

  const signOut = useCallback(async () => {
    await window.jarvis.auth.signOut()
    setStatus({ state: 'signed_out' })
  }, [])

  return { status, authorizing: status.state === 'authorizing', signIn, signOut }
}
