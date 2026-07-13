import { lazy, Suspense, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CoreMode } from '../../../../shared/types'
import type { BgMode } from './GraphCore'

// Vite lazy import — the three.js bundle only loads once the HUD mounts
const GraphCore = lazy(() => import('./GraphCore'))

// ---------------------------------------------------------------------------
// HUD SHELL — the fixed full-viewport stage. Orb centered, four edge zones
// as slot props, status line (mode + clock) across the top, scrims for
// legibility, film grain over everything. Desktop 1280px+, never scrolls.
// Boot choreography: zones cascade in 0.05–0.46s, orb ignites at 0.65s (CSS).
// ---------------------------------------------------------------------------

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function useClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

function Clock(): React.JSX.Element {
  const now = useClock()
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return (
    <div className="clock-wrap">
      <div className="clock">
        {p2(now.getHours())}:{p2(now.getMinutes())}
        <span className="sec">:{p2(now.getSeconds())}</span>
      </div>
      <div className="clock-date">
        {DAYS[now.getDay()]} · {MONTHS[now.getMonth()]} {now.getDate()}
      </div>
    </div>
  )
}

export interface HudShellProps {
  /** drives the orb + the mode chip; cobalt=listening, warn=speaking, err=red-locked */
  mode: CoreMode
  bgMode?: BgMode
  /** real speech envelope 0..1 (AnalyserNode RMS), or null when no audio is live */
  getLevel?: () => number | null
  /** top-left: identity / auth status (renders under the wordmark) */
  topLeft?: ReactNode
  /** top-right: connectors summary (renders under the clock) */
  topRight?: ReactNode
  /** bottom-left: transcript aside panel */
  bottomLeft?: ReactNode
  /** bottom-right: tasks / codex zone */
  bottomRight?: ReactNode
  /** extra chips in the centered status line, after the mode chip */
  statusExtra?: ReactNode
  /** floats over the orb (callout cards etc.) — pointer-events pass through */
  center?: ReactNode
  /** overlays (report/transcript modal) — rendered above the grain */
  overlay?: ReactNode
}

export default function HudShell({
  mode,
  bgMode = 'depth',
  getLevel,
  topLeft,
  topRight,
  bottomLeft,
  bottomRight,
  statusExtra,
  center,
  overlay
}: HudShellProps): React.JSX.Element {
  return (
    <main className="stage">
      <Suspense fallback={null}>
        <GraphCore mode={mode} bgMode={bgMode} getLevel={getLevel} />
      </Suspense>

      <div className="scrim scrim-l" aria-hidden="true" />
      <div className="scrim scrim-r" aria-hidden="true" />
      <div className="scrim scrim-b" aria-hidden="true" />
      <div className="scrim scrim-t" aria-hidden="true" />

      <div className="hud">
        <div className="zone zone-tl boot-stagger" style={{ animationDelay: '0.05s' }}>
          <div className="wordmark">
            <span className="name">J.A.R.V.I.S.</span>
            <span className="expansion">Just A Rather Very Intelligent System</span>
          </div>
          {topLeft}
        </div>

        <div className="zone zone-status boot-stagger" style={{ animationDelay: '0.12s' }}>
          <div className="status-line">
            <span className={`mode-chip mode-${mode}`}>
              <i className="status-dot" /> core · {mode}
            </span>
            {statusExtra}
          </div>
        </div>

        <div className="zone zone-tr boot-stagger" style={{ animationDelay: '0.18s' }}>
          <Clock />
          {topRight}
        </div>

        <div className="zone zone-bl boot-stagger" style={{ animationDelay: '0.34s' }}>
          {bottomLeft}
        </div>

        <div className="hud-center">{center}</div>

        <div className="zone zone-br boot-stagger" style={{ animationDelay: '0.46s' }}>
          {bottomRight}
        </div>
      </div>

      {overlay}

      <div className="grain" aria-hidden="true" />
    </main>
  )
}
