/**
 * ChatGPT Apps available to the signed-in account. Connection pages open in
 * the system browser; Jarvis never receives an app password or OAuth secret.
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
}

function CardRow({ card, busy, onConnect }: CardRowProps): JSX.Element {
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
      {!isConnected && card.status !== 'not_configured' && (
        <button
          type="button"
          className="cx-action"
          disabled={!canAct}
          onClick={() => onConnect(card.slug)}
        >
          connect
        </button>
      )}
      {card.detail && <span className="cx-detail">{card.detail}</span>}
    </li>
  )
}

export function ConnectorsPanel(): JSX.Element {
  const { cards, loading, refreshing, busySlug, error, connect, refresh } = useConnectors()

  return (
    <section className="cx-panel" aria-label="Connectors">
      <div className="cx-kicker">Connectors</div>

      <header className="cx-section-header">
        <h2 className="cx-section-title">CHATGPT APPS</h2>
        <span className="cx-section-rule" aria-hidden="true" />
        <button
          type="button"
          className="cx-refresh"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? 'checking…' : 'refresh'}
        </button>
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
            />
          ))}
        </ul>
      )}

      {error && <footer className="cx-footer-hint">{error}</footer>}
      {!loading && !error && cards.length === 0 && (
        <footer className="cx-footer-hint">
          No ChatGPT apps are available for this account yet.
        </footer>
      )}
      <p className="cx-privacy">Connections stay with ChatGPT · opens in your browser</p>
    </section>
  )
}

export default ConnectorsPanel
