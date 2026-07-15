import { useAuth } from './useAuth'

export function LoginScreen(): React.JSX.Element {
  const { status, authorizing, signIn, cancelSignIn } = useAuth()
  const checking = status.state === 'checking'

  return (
    <main className="login-screen">
      <div className="login-core" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <section className="login-content" aria-live="polite">
        <p className="login-eyebrow">PRIVATE DESKTOP CORE · MACOS</p>
        <h1 className="login-wordmark">JARVIS</h1>
        <p className="login-deck">
          {checking
            ? 'Checking your secure session'
            : authorizing
              ? 'Your browser is handling the sign-in'
              : 'Your ChatGPT account powers the core'}
        </p>

        {checking && (
          <div className="login-progress" role="status">
            <span className="login-spinner" aria-hidden="true" />
            <span>CHECKING SECURE SESSION</span>
          </div>
        )}

        {authorizing && (
          <div className="login-authorizing">
            <div className="login-progress" role="status">
              <span className="login-spinner" aria-hidden="true" />
              <span>
                {status.state === 'authorizing' && status.phase === 'securing_session'
                  ? 'SECURING SESSION'
                  : 'WAITING FOR APPROVAL'}
              </span>
            </div>
            <p className="login-hint">Finish in the browser, then return here.</p>
            <button className="login-secondary" type="button" onClick={() => void signIn()}>
              Reopen sign-in
            </button>
            <button className="login-secondary" type="button" onClick={() => void cancelSignIn()}>
              Cancel
            </button>
          </div>
        )}

        {!checking && !authorizing && (
          <div className="login-actions">
            {status.state === 'error' && (
              <p className="login-error" role="alert">
                {status.message}
              </p>
            )}
            <button className="login-button" type="button" onClick={() => void signIn()}>
              {status.state === 'error' ? 'Retry with ChatGPT' : 'Continue with ChatGPT'}
            </button>
            <p className="login-subhint">
              No API key · credentials stay with the local Codex service
            </p>
          </div>
        )}
      </section>
      <footer className="login-footer">
        <span>MICROPHONE OFF</span>
        <span>APPS REQUIRE YOUR APPROVAL</span>
        <span>LOCAL RECEIPTS</span>
      </footer>
    </main>
  )
}

export default LoginScreen
