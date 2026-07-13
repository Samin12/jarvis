/**
 * ConnectorsPanel — the Connectors panel with its dedicated COMPOSIO section
 * (PLAN step 4). Cards: name, status dot, CONNECT/DISCONNECT action, detail
 * line. Footer hint appears when the Composio key is missing.
 */
import type { JSX } from 'react'
import type { ConnectorCard, ConnectorStatus } from '../../../../shared/types'
import { useConnectors } from './useConnectors'
import './connectors.css'

const STATUS_LABEL: Record<ConnectorStatus, string> = {
  connected: 'connected',
  connecting: 'connecting',
  disconnected: 'offline',
  not_configured: 'setup needed',
  error: 'error'
}

interface CardRowProps {
  card: ConnectorCard
  busy: boolean
  onConnect: (slug: string) => void
  onDisconnect: (slug: string) => void
}

function CardRow({ card, busy, onConnect, onDisconnect }: CardRowProps): JSX.Element {
  const isConnected = card.status === 'connected'
  const canAct = card.status !== 'not_configured' && card.status !== 'connecting' && !busy

  return (
    <li className="cx-card">
      <span className={`cx-dot cx-dot--${card.status}`} aria-hidden="true" />
      <span className="cx-title">
        {card.title}
        <span className={`cx-status cx-status--${card.status}`}>
          {busy ? 'working' : STATUS_LABEL[card.status]}
        </span>
      </span>
      {card.status !== 'not_configured' && (
        <button
          type="button"
          className={`cx-action${isConnected ? ' cx-action--disconnect' : ''}`}
          disabled={!canAct}
          onClick={() => (isConnected ? onDisconnect(card.slug) : onConnect(card.slug))}
        >
          {isConnected ? 'disconnect' : 'connect'}
        </button>
      )}
      {card.detail && <span className="cx-detail">{card.detail}</span>}
    </li>
  )
}

export function ConnectorsPanel(): JSX.Element {
  const { cards, loading, busySlug, composioKeyMissing, connect, disconnect } = useConnectors()

  return (
    <section className="cx-panel" aria-label="Connectors">
      <div className="cx-kicker">Connectors</div>

      <header className="cx-section-header">
        <h2 className="cx-section-title">COMPOSIO</h2>
        <span className="cx-section-rule" aria-hidden="true" />
      </header>

      {loading ? (
        <div className="cx-empty">scanning connectors…</div>
      ) : (
        <ul className="cx-cards">
          {cards.map((card) => (
            <CardRow
              key={card.slug}
              card={card}
              busy={busySlug === card.slug}
              onConnect={(slug) => void connect(slug)}
              onDisconnect={(slug) => void disconnect(slug)}
            />
          ))}
        </ul>
      )}

      {composioKeyMissing && (
        <footer className="cx-footer-hint">
          Add COMPOSIO_API_KEY to enable connectors — see docs/CONNECTORS.md for the 10-minute
          setup.
        </footer>
      )}
    </section>
  )
}

export default ConnectorsPanel
