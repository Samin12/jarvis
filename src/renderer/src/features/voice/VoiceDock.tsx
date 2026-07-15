/**
 * Minimal voice control strip for the HUD bottom center.
 * classNames only — the hud agent styles these (voice-dock* hooks).
 */
import { useState, type FormEvent, type JSX } from 'react'
import type { UseVoiceResult } from './useVoice'

export interface VoiceDockProps {
  voice: UseVoiceResult
}

export function VoiceDock({ voice }: VoiceDockProps): JSX.Element {
  const [draft, setDraft] = useState('')

  const laneLabel = voice.lane === 'realtime' ? 'LIVE' : voice.lane === 'fallback' ? 'LOCAL' : '—'
  const laneClass = voice.lane ?? 'probing'

  const submitDraft = (e: FormEvent): void => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    voice.sendText(text)
    setDraft('')
  }

  return (
    <div
      className={[
        'voice-dock',
        `voice-dock--${voice.coreMode}`,
        voice.active ? 'voice-dock--active' : 'voice-dock--inactive'
      ].join(' ')}
    >
      <span
        className={`voice-dock__mic ${voice.micOpen ? 'voice-dock__mic--open' : 'voice-dock__mic--closed'}`}
        title={voice.micOpen ? 'Mic open' : 'Mic closed'}
        aria-label={voice.micOpen ? 'Microphone open' : 'Microphone closed'}
      />

      <span className={`voice-dock__badge voice-dock__badge--${laneClass}`}>{laneLabel}</span>

      {voice.starting ? (
        <button
          type="button"
          className="voice-dock__btn voice-dock__btn--stop"
          aria-label="Cancel voice startup"
          onClick={voice.stop}
        >
          Cancel
        </button>
      ) : !voice.active ? (
        <button
          type="button"
          className="voice-dock__btn voice-dock__btn--start"
          onClick={() => void voice.start()}
        >
          Engage
        </button>
      ) : (
        <button
          type="button"
          className="voice-dock__btn voice-dock__btn--stop"
          onClick={voice.stop}
        >
          Stand down
        </button>
      )}

      {voice.starting && <span className="voice-dock__hint">opening secure voice channel…</span>}

      {voice.active && (
        <button
          type="button"
          className="voice-dock__btn voice-dock__btn--greet"
          onClick={voice.greet}
        >
          “Good morning, Jarvis”
        </button>
      )}

      {voice.active &&
        (voice.lane === 'realtime' ||
          voice.localVoiceState === 'ready' ||
          voice.localVoiceState === 'listening' ||
          voice.localVoiceState === 'speaking') && (
          <span className="voice-dock__hint">hold Space to talk</span>
        )}

      {voice.active && (
        <form className="voice-dock__form" onSubmit={submitDraft}>
          <input
            className="voice-dock__input"
            type="text"
            value={draft}
            aria-label="Message Jarvis"
            placeholder="Type to Jarvis…"
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
      )}

      {voice.active && voice.localVoiceState === 'permission_denied' && (
        <span className="voice-dock__error">
          microphone permission denied · text remains available
        </span>
      )}

      {voice.error && <span className="voice-dock__error">{voice.error}</span>}
    </div>
  )
}
