/**
 * useCodex — renderer state for the Codex bridge.
 * Wraps window.jarvis.codex (dispatch/cancel/list/receipts) and folds
 * codex:event / codex:taskChanged pushes into local task state.
 *
 * Self-contained on purpose: the integration agent can lift this state into the
 * global appState later — the exported CodexAction union is the reducer contract.
 */
import { useCallback, useEffect, useReducer, useState } from 'react'
import type {
  CodexBoundary,
  CodexEventRow,
  CodexRunReceipt,
  CodexTaskRow
} from '../../../../shared/types'

export type CodexAction =
  | { type: 'codex/tasksLoaded'; tasks: CodexTaskRow[] }
  | { type: 'codex/taskChanged'; task: CodexTaskRow }
  | { type: 'codex/event'; taskId: string; row: CodexEventRow }

export interface CodexTasksState {
  /** newest first */
  tasks: CodexTaskRow[]
}

export function codexTasksReducer(state: CodexTasksState, action: CodexAction): CodexTasksState {
  switch (action.type) {
    case 'codex/tasksLoaded':
      return { tasks: sortTasks(action.tasks) }
    case 'codex/taskChanged': {
      const rest = state.tasks.filter((t) => t.taskId !== action.task.taskId)
      return { tasks: sortTasks([...rest, action.task]) }
    }
    case 'codex/event': {
      const existing = state.tasks.find((t) => t.taskId === action.taskId)
      if (!existing) return state // taskChanged push (or refresh) will bring the full row
      const updated: CodexTaskRow = { ...existing, events: [...existing.events, action.row] }
      return { tasks: state.tasks.map((t) => (t.taskId === action.taskId ? updated : t)) }
    }
    default:
      return state
  }
}

function sortTasks(tasks: CodexTaskRow[]): CodexTaskRow[] {
  return [...tasks].sort((a, b) => b.startedAt - a.startedAt)
}

export interface UseCodexResult {
  /** newest first */
  tasks: CodexTaskRow[]
  receipts: CodexRunReceipt[]
  receiptsVisible: boolean
  loggedIn: boolean | null // null = still probing `codex login status`
  dispatch: (
    prompt: string,
    opts?: { cwd?: string; fullAccess?: boolean; boundary?: CodexBoundary }
  ) => Promise<{ taskId: string }>
  cancel: (taskId: string) => Promise<void>
  refresh: () => Promise<void>
  toggleReceipts: () => void
}

export function useCodex(): UseCodexResult {
  const [state, dispatchState] = useReducer(codexTasksReducer, { tasks: [] })
  const [receipts, setReceipts] = useState<CodexRunReceipt[]>([])
  const [receiptsVisible, setReceiptsVisible] = useState(false)
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const tasks = await window.jarvis.codex.list()
    dispatchState({ type: 'codex/tasksLoaded', tasks })
  }, [])

  useEffect(() => {
    void refresh()
    void window.jarvis.codex
      .loginStatus()
      .then((s) => setLoggedIn(s.loggedIn))
      .catch(() => setLoggedIn(false))

    const offEvent = window.jarvis.codex.onEvent(({ taskId, row }) => {
      dispatchState({ type: 'codex/event', taskId, row })
    })
    const offChanged = window.jarvis.codex.onTaskChanged((task) => {
      dispatchState({ type: 'codex/taskChanged', task })
    })
    return () => {
      offEvent()
      offChanged()
    }
  }, [refresh])

  // whenever a task finishes while the receipts drawer is open, refresh it
  const doneCount = state.tasks.filter((t) => t.state !== 'running').length
  useEffect(() => {
    if (!receiptsVisible) return
    void window.jarvis.codex
      .receipts()
      .then(setReceipts)
      .catch(() => setReceipts([]))
  }, [receiptsVisible, doneCount])

  const dispatch = useCallback<UseCodexResult['dispatch']>(
    async (prompt, opts) => {
      const result = await window.jarvis.codex.dispatch({ prompt, ...opts })
      await refresh() // taskChanged push also covers this; refresh guards a missed race
      return result
    },
    [refresh]
  )

  const cancel = useCallback(async (taskId: string): Promise<void> => {
    await window.jarvis.codex.cancel(taskId)
  }, [])

  const toggleReceipts = useCallback((): void => {
    setReceiptsVisible((v) => !v)
  }, [])

  return {
    tasks: state.tasks,
    receipts,
    receiptsVisible,
    loggedIn,
    dispatch,
    cancel,
    refresh,
    toggleReceipts
  }
}
