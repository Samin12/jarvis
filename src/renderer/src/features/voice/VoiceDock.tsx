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

  const laneLabel =
    voice.lane === 'realtime' ? 'LIVE' : voice.lane === 'fallback' ? 'FALLBACK' : '—'
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

      {!voice.active ? (
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

      {voice.active && (
        <button
          type="button"
          className="voice-dock__btn voice-dock__btn--greet"
          onClick={voice.greet}
        >
          “Good morning, Jarvis”
        </button>
      )}

      {voice.active && voice.lane === 'realtime' && (
        <span className="voice-dock__hint">hold Space to talk</span>
      )}

      {voice.active && voice.lane === 'fallback' && (
        <form className="voice-dock__form" onSubmit={submitDraft}>
          <input
            className="voice-dock__input"
            type="text"
            value={draft}
            placeholder="Type to Jarvis…"
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
      )}

      {voice.error && <span className="voice-dock__error">{voice.error}</span>}
    </div>
  )
}
