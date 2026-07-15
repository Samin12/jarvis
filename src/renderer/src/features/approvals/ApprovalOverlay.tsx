import { useEffect, useRef, useState } from 'react'
import { useApprovals } from './useApprovals'
import './approvals.css'

export function ApprovalOverlay(): React.JSX.Element | null {
  const { approvals, deciding, error, decide } = useApprovals()
  const approval = approvals[0]
  const denyRef = useRef<HTMLButtonElement>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (approval) denyRef.current?.focus()
  }, [approval])

  useEffect(() => {
    if (!approval) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [approval])

  if (!approval) return null
  const seconds = Math.max(0, Math.ceil((approval.expiresAt - now) / 1_000))
  const busy = deciding === approval.approvalId

  return (
    <div className="approval-scrim" role="presentation">
      <section
        className="approval-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-description"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            void decide(approval.approvalId, 'deny')
          }
        }}
      >
        <header className="approval-header">
          <span className="approval-kicker">ACTION PREVIEW</span>
          <span className="approval-expiry">expires in {seconds}s</span>
        </header>
        <h2 id="approval-title">{approval.operation}</h2>
        <p id="approval-description">
          Jarvis is waiting for your decision before running this exact action.
        </p>
        <dl className="approval-facts">
          <div>
            <dt>Target</dt>
            <dd>{approval.target}</dd>
          </div>
          <div>
            <dt>Access</dt>
            <dd>{approval.capability.replace('.', ' · ')}</dd>
          </div>
          <div>
            <dt>Data</dt>
            <dd>{approval.dataClassification}</dd>
          </div>
          <div>
            <dt>Policy</dt>
            <dd>{approval.reason}</dd>
          </div>
        </dl>
        {approval.detail?.kind === 'command' && (
          <section className="approval-exact" aria-label="Exact command to run">
            <h3>Exact command</h3>
            <pre>
              <code>{approval.detail.command}</code>
            </pre>
            <p>
              Working directory <code>{approval.detail.cwd}</code>
            </p>
          </section>
        )}
        {approval.detail?.kind === 'task_dispatch' && (
          <section className="approval-exact" aria-label="Exact Codex task to dispatch">
            <h3>Exact Codex task</h3>
            <pre>
              <code>{approval.detail.prompt}</code>
            </pre>
            <p>
              Selected folder <code>{approval.detail.workspace}</code>
            </p>
          </section>
        )}
        {approval.detail?.kind === 'file_change' && (
          <section className="approval-exact" aria-label="Exact file changes">
            <h3>Exact file changes</h3>
            {approval.detail.changes.map((change, index) => (
              <article
                className="approval-change"
                key={`${change.changeType}:${change.path}:${index}`}
              >
                <p>
                  <strong>{change.changeType}</strong> <code>{change.path}</code>
                  {change.movePath ? (
                    <>
                      {' → '}
                      <code>{change.movePath}</code>
                    </>
                  ) : null}
                </p>
                <pre>
                  <code>{change.diff || '(empty diff)'}</code>
                </pre>
              </article>
            ))}
          </section>
        )}
        {error && (
          <p className="approval-error" role="alert">
            Decision not recorded: {error}
          </p>
        )}
        <p className="approval-id">approval · {approval.approvalId.slice(0, 8)}</p>
        <footer className="approval-actions">
          <button
            ref={denyRef}
            type="button"
            disabled={busy}
            onClick={() => void decide(approval.approvalId, 'deny')}
          >
            Cancel
          </button>
          <button
            type="button"
            className="approval-run"
            disabled={busy}
            onClick={() => void decide(approval.approvalId, 'approve')}
          >
            {busy ? 'Recording decision…' : 'Run once'}
          </button>
        </footer>
      </section>
    </div>
  )
}
