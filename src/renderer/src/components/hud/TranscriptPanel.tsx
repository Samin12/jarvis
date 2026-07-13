import { useEffect, useRef } from 'react'
import type { TranscriptEntry } from '../../../../shared/types'

// ---------------------------------------------------------------------------
// TRANSCRIPT — the aside conversation ring (bottom-left zone). Rows float on
// the scrim, no box: [hh:mm:ss] who · text, tool calls get a status chip.
// Auto-scrolls to the newest line; RESET clears via the onReset callback.
// ---------------------------------------------------------------------------

const TOOL_LABEL: Record<NonNullable<TranscriptEntry['tool']>['status'], string> = {
  running: 'running',
  done: 'done',
  error: 'error',
  awaiting_confirmation: 'confirm?'
}

function stamp(at: number): string {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

const MAX_ROWS = 200

export default function TranscriptPanel({
  entries,
  onReset
}: {
  entries: TranscriptEntry[]
  onReset?: () => void
}): React.JSX.Element {
  const feedRef = useRef<HTMLDivElement>(null)

  // keep the newest exchange in view
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  const rows = entries.length > MAX_ROWS ? entries.slice(-MAX_ROWS) : entries

  return (
    <aside className="transcript-panel block">
      <div className="sec-title">
        <span>Transcript</span>
        <span className="tick">{entries.length > 0 ? `${entries.length} LINES` : 'STANDBY'}</span>
      </div>
      <div className="transcript-feed" ref={feedRef}>
        {rows.length === 0 && <div className="t-empty">awaiting first exchange</div>}
        {rows.map((e) => (
          <div key={e.id} className={`t-entry ${e.role}`}>
            <span className="ts">{stamp(e.at)}</span>
            <span className="who">
              {e.role === 'user' ? 'you' : e.role === 'jarvis' ? 'jarvis' : 'sys'}
            </span>
            <span className="txt">{e.text}</span>
            {e.tool && (
              <span className={`tool-chip ${e.tool.status}`}>
                {e.tool.name} · {TOOL_LABEL[e.tool.status]}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="transcript-foot">
        <button
          className="panel-btn danger"
          onClick={onReset}
          disabled={!onReset || entries.length === 0}
        >
          Reset
        </button>
      </div>
    </aside>
  )
}
