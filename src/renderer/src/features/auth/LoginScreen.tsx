import type { CSSProperties, JSX } from 'react'
import { useAuth } from './useAuth'

/**
 * Full-viewport sign-in gate. Styling is intentionally minimal — every element
 * carries a `login-*` className so the hud agent's global stylesheet can
 * restyle it without touching this file.
 */
export function LoginScreen(): JSX.Element {
  const { status, authorizing, signIn } = useAuth()

  return (
    <div className="login-screen" style={styles.screen}>
      <style>{spinnerCss}</style>
      <div className="login-wordmark" style={styles.wordmark}>
        JARVIS
      </div>

      {authorizing ? (
        <div className="login-authorizing" style={styles.stack}>
          <div className="login-spinner" style={styles.spinner} aria-label="Waiting for browser" />
          <p className="login-hint" style={styles.hint}>
            Complete sign-in in your browser
          </p>
          <p className="login-subhint" style={styles.subhint}>
            Jarvis is listening on localhost for the callback
          </p>
        </div>
      ) : (
        <div className="login-actions" style={styles.stack}>
          {status.state === 'error' && (
            <p className="login-error" role="alert" style={styles.error}>
              {status.message}
            </p>
          )}
          <button
            className="login-button"
            style={styles.button}
            onClick={() => {
              void signIn()
            }}
          >
            {status.state === 'error' ? 'Retry sign-in with ChatGPT' : 'Sign in with ChatGPT'}
          </button>
          <p className="login-subhint" style={styles.subhint}>
            Uses your ChatGPT account — no API key required
          </p>
        </div>
      )}
    </div>
  )
}

const spinnerCss = `
@keyframes login-spin { to { transform: rotate(360deg); } }
.login-spinner { animation: login-spin 0.9s linear infinite; }
.login-button:hover { border-color: rgba(255, 255, 255, 0.55); }
`

const styles: Record<string, CSSProperties> = {
  screen: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '2.5rem',
    background: '#0b0b0f',
    color: '#e8e8ee',
    zIndex: 100
  },
  wordmark: {
    fontSize: '2rem',
    fontWeight: 700,
    letterSpacing: '0.55em',
    marginRight: '-0.55em', // optical centering against the tracking
    userSelect: 'none'
  },
  stack: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.9rem',
    minHeight: '7rem',
    justifyContent: 'flex-start'
  },
  button: {
    appearance: 'none',
    background: 'transparent',
    color: 'inherit',
    border: '1px solid rgba(255, 255, 255, 0.28)',
    borderRadius: '999px',
    padding: '0.8rem 1.9rem',
    fontSize: '0.95rem',
    letterSpacing: '0.06em',
    cursor: 'pointer'
  },
  spinner: {
    width: '1.6rem',
    height: '1.6rem',
    borderRadius: '50%',
    border: '2px solid rgba(255, 255, 255, 0.18)',
    borderTopColor: 'rgba(255, 255, 255, 0.85)'
  },
  hint: {
    margin: 0,
    fontSize: '0.95rem',
    color: '#a0a0b2'
  },
  subhint: {
    margin: 0,
    fontSize: '0.75rem',
    color: '#63636f'
  },
  error: {
    margin: 0,
    maxWidth: '26rem',
    textAlign: 'center',
    fontSize: '0.85rem',
    color: '#ff8f8f',
    lineHeight: 1.5
  }
}

export default LoginScreen
