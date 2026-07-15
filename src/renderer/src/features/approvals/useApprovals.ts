import { useCallback, useEffect, useState } from 'react'
import type { HostApprovalPreview } from '../../../../shared/types'

export interface UseApprovalsResult {
  approvals: HostApprovalPreview[]
  deciding: string | null
  error: string | null
  decide: (approvalId: string, decision: 'approve' | 'deny') => Promise<void>
}

export function useApprovals(): UseApprovalsResult {
  const [approvals, setApprovals] = useState<HostApprovalPreview[]>([])
  const [deciding, setDeciding] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!window.jarvis) return undefined
    let mounted = true
    void window.jarvis.approvals
      .list()
      .then((items) => mounted && setApprovals(items))
      .catch(() => mounted && setApprovals([]))
    const off = window.jarvis.approvals.onChanged((items) => {
      setApprovals(items)
      setError(null)
    })
    return () => {
      mounted = false
      off()
    }
  }, [])

  const decide = useCallback(
    async (approvalId: string, decision: 'approve' | 'deny'): Promise<void> => {
      setDeciding(approvalId)
      setError(null)
      try {
        await window.jarvis.approvals.decide(approvalId, decision)
        setApprovals((items) => items.filter((item) => item.approvalId !== approvalId))
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Jarvis could not record that decision. Review the current approval and try again.'
        )
      } finally {
        setDeciding(null)
      }
    },
    []
  )

  return { approvals, deciding, error, decide }
}
