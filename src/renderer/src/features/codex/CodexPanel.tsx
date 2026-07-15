/**
 * CodexPanel — HUD task rows for dispatched Codex work.
 * Prompt one-liner + spinner/terminal badge, expandable event feed
 * (monospace command rows, file_change badges, todo checklist),
 * cancel button, receipts history toggle. classNames only — styling
 * lives in the HUD design system.
 */
import { useState, type FormEvent } from 'react'
import type {
  ActionReceiptRow,
  CodexEventRow,
  CodexTaskRow,
  CodexTerminalState
} from '../../../../shared/types'
import { useAppState } from '../../state/appState'
import { useCodex } from './useCodex'

const PERSONAL_ACTION_PLANS = new Set(['free', 'go', 'plus', 'pro', 'prolite'])

const TERMINAL_LABEL: Record<CodexTerminalState, string> = {
  success: 'SUCCESS',
  clean_noop: 'CLEAN NO-OP',
  blocked: 'BLOCKED',
  approval_required: 'NEEDS APPROVAL',
  exhausted: 'EXHAUSTED',
  no_progress: 'NO PROGRESS',
  unknown_outcome: 'OUTCOME UNKNOWN'
}

function badgeFor(task: CodexTaskRow): { label: string; className: string; running: boolean } {
  if (task.state === 'running') {
    return { label: 'RUNNING', className: 'codex-badge codex-badge--running', running: true }
  }
  if (task.state === 'cancelled') {
    return { label: 'CANCELLED', className: 'codex-badge codex-badge--cancelled', running: false }
  }
  const terminal = task.terminal
  if (terminal) {
    return {
      label: TERMINAL_LABEL[terminal],
      className: `codex-badge codex-badge--${terminal.replace(/_/g, '-')}`,
      running: false
    }
  }
  return { label: 'FAILED', className: 'codex-badge codex-badge--blocked', running: false }
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function CodexPanel(): React.JSX.Element {
  const {
    tasks,
    receipts,
    receiptsVisible,
    loggedIn,
    taskEligible,
    dispatch,
    selectWorkspace,
    cancel,
    toggleReceipts
  } = useCodex()
  const { auth } = useAppState()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [prompt, setPrompt] = useState('')
  const [workspace, setWorkspace] = useState<{ scopeId: string; path: string } | null>(null)
  const [dispatching, setDispatching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleExpand = (taskId: string): void =>
    setExpanded((prev) => ({ ...prev, [taskId]: !prev[taskId] }))

  const chooseWorkspace = async (): Promise<void> => {
    if (taskEligible !== true) return
    setError(null)
    try {
      const selected = await selectWorkspace()
      if (selected) setWorkspace(selected)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const task = prompt.trim()
    if (!task || !workspace || dispatching || taskEligible !== true) return
    setDispatching(true)
    setError(null)
    try {
      await dispatch(task, {
        scopeId: workspace.scopeId,
        boundary: { wallClockMs: 10 * 60_000 }
      })
      setPrompt('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDispatching(false)
    }
  }

  return (
    <section className="codex-panel" aria-label="Codex tasks">
      <header className="codex-panel-header">
        <span className="codex-panel-title">CODEX TASKS</span>
        {loggedIn === false && (
          <span className="codex-login-warning">codex sign-in not detected</span>
        )}
        <button
          type="button"
          className={`codex-receipts-toggle${receiptsVisible ? ' codex-receipts-toggle--active' : ''}`}
          onClick={toggleReceipts}
        >
          {receiptsVisible ? 'HIDE RECEIPTS' : 'RECEIPTS'}
        </button>
      </header>

      <form className="codex-compose" onSubmit={(event) => void submit(event)}>
        {loggedIn === true && taskEligible === false && (
          <p className="codex-eligibility-note" role="status">
            {taskEligibilityMessage(auth.state === 'signed_in' ? auth.planType : null)}
          </p>
        )}
        <button
          type="button"
          className="codex-workspace"
          onClick={() => void chooseWorkspace()}
          disabled={taskEligible !== true}
          title={
            taskEligible === true
              ? (workspace?.path ?? 'Choose a workspace')
              : 'Verified folder tasks are unavailable for this account'
          }
        >
          <span>WORKSPACE</span>
          <strong>{workspace ? compactPath(workspace.path) : 'CHOOSE FOLDER'}</strong>
        </button>
        <div className="codex-compose-row">
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Ask Codex to work in this folder"
            aria-label="Codex task"
            maxLength={32_000}
            disabled={taskEligible !== true}
          />
          <button
            type="submit"
            disabled={
              !workspace ||
              !prompt.trim() ||
              dispatching ||
              tasks.some((task) => task.state === 'running') ||
              taskEligible !== true
            }
          >
            {dispatching ? 'QUEUING' : 'RUN'}
          </button>
        </div>
        {error && <p className="codex-compose-error">{error}</p>}
      </form>

      {tasks.length === 0 && !receiptsVisible && (
        <p className="codex-empty">No tasks dispatched yet.</p>
      )}

      <ul className="codex-task-list">
        {tasks.map((task) => (
          <TaskRow
            key={task.taskId}
            task={task}
            expanded={!!expanded[task.taskId]}
            onToggle={() => toggleExpand(task.taskId)}
            onCancel={() => void cancel(task.taskId)}
          />
        ))}
      </ul>

      {receiptsVisible && <ReceiptsHistory receipts={receipts} />}
    </section>
  )
}

function taskEligibilityMessage(planType: string | null): string {
  if (planType && PERSONAL_ACTION_PLANS.has(planType.toLowerCase())) {
    return 'Secure action identity is unavailable, so verified folder tasks are paused. Chat and Apps still work.'
  }
  return 'Verified folder tasks require an eligible personal ChatGPT account. Chat and Apps still work.'
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join(' / ') || path
}

function TaskRow({
  task,
  expanded,
  onToggle,
  onCancel
}: {
  task: CodexTaskRow
  expanded: boolean
  onToggle: () => void
  onCancel: () => void
}): React.JSX.Element {
  const badge = badgeFor(task)
  return (
    <li className={`codex-task codex-task--${task.state}`}>
      <div className="codex-task-head">
        <button
          type="button"
          className="codex-task-expand"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className={badge.className}>
          {badge.running && <span className="codex-spinner" aria-hidden="true" />}
          {badge.label}
        </span>
        <span className="codex-task-prompt" title={task.prompt}>
          {task.prompt}
        </span>
        <span className="codex-task-time">{timeLabel(task.startedAt)}</span>
        {badge.running && (
          <button type="button" className="codex-cancel-btn" onClick={onCancel}>
            CANCEL
          </button>
        )}
      </div>

      {task.spokenSummary && !badge.running && (
        <p className="codex-task-summary">{task.spokenSummary}</p>
      )}

      {expanded && (
        <ul className="codex-event-feed">
          {task.events.map((row, i) => (
            <EventRow key={`${task.taskId}-${i}`} row={row} />
          ))}
          {task.events.length === 0 && (
            <li className="codex-event codex-event--empty">no events yet</li>
          )}
        </ul>
      )}
    </li>
  )
}

function EventRow({ row }: { row: CodexEventRow }): React.JSX.Element {
  if (row.kind === 'command') {
    return (
      <li className="codex-event codex-event--command">
        <code className="codex-mono">{row.summary}</code>
      </li>
    )
  }
  if (row.kind === 'file_change') {
    return (
      <li className="codex-event codex-event--file-change">
        {row.summary.split(', ').map((entry, i) => {
          const kind = entry.startsWith('A ') ? 'add' : entry.startsWith('D ') ? 'delete' : 'update'
          return (
            <span key={i} className={`codex-file-badge codex-file-badge--${kind}`}>
              {entry}
            </span>
          )
        })}
      </li>
    )
  }
  if (row.kind === 'todo') {
    return (
      <li className="codex-event codex-event--todo">
        <ul className="codex-todo-list">
          {row.summary.split('\n').map((line, i) => {
            const done = line.startsWith('[x]')
            return (
              <li key={i} className={`codex-todo-item${done ? ' codex-todo-item--done' : ''}`}>
                <span className="codex-todo-check" aria-hidden="true">
                  {done ? '☑' : '☐'}
                </span>
                {line.replace(/^\[[x ]\]\s*/, '')}
              </li>
            )
          })}
        </ul>
      </li>
    )
  }
  return <li className={`codex-event codex-event--${row.kind}`}>{row.summary}</li>
}

const ACTION_TERMINAL_LABEL: Record<ActionReceiptRow['terminal'], string> = {
  success: 'VERIFIED',
  denied: 'DENIED',
  blocked: 'BLOCKED',
  unknown_outcome: 'OUTCOME UNKNOWN'
}

function ReceiptsHistory({ receipts }: { receipts: ActionReceiptRow[] }): React.JSX.Element {
  return (
    <div className="codex-receipts">
      <span className="codex-receipts-title">ACTION RECEIPTS</span>
      {receipts.length === 0 && <p className="codex-empty">No receipts recorded yet.</p>}
      <ul className="codex-receipt-list">
        {receipts.map((r) => (
          <li key={r.receiptId} className="codex-receipt">
            <span className={`codex-badge codex-badge--${r.terminal.replace(/_/g, '-')}`}>
              {ACTION_TERMINAL_LABEL[r.terminal]}
            </span>
            <span className="codex-receipt-time">{new Date(r.finishedAt).toLocaleString()}</span>
            <span className="codex-receipt-hash codex-mono" title={r.intentHash}>
              {r.intentHash.slice(0, 8)}
            </span>
            <strong className="codex-receipt-operation">{r.operation}</strong>
            <span className="codex-receipt-target codex-mono" title={r.target}>
              {compactPath(r.target)}
            </span>
            <p className="codex-receipt-evidence">
              {r.summary} Verification: {r.verification}.
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default CodexPanel
