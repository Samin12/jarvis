import type { CoreMode } from '../../../../shared/types'

export interface MissionCenterProps {
  mode: CoreMode
  voiceActive: boolean
  voiceStarting: boolean
  onStart: () => Promise<void>
}

const MODE_COPY: Record<CoreMode, string> = {
  idle: 'Ready when you are',
  listening: 'Listening',
  working: 'Building your answer',
  speaking: 'Speaking',
  error: 'Needs attention'
}

export function MissionCenter({
  mode,
  voiceActive,
  voiceStarting,
  onStart
}: MissionCenterProps): React.JSX.Element {
  return (
    <section className="mission-center" aria-label={`Jarvis ${MODE_COPY[mode].toLowerCase()}`}>
      <div className="mission-branch" aria-hidden="true" />
      <p className="mission-kicker">TODAY&apos;S MISSION</p>
      <h2>{MODE_COPY[mode]}</h2>
      <p className="mission-summary">
        {voiceActive
          ? 'Hold Space to talk, or begin with the calendar and inbox apps you connect.'
          : 'Start with a private brief from the ChatGPT apps already available to you.'}
      </p>
      <button
        type="button"
        onClick={() => void onStart()}
        disabled={mode === 'working' || voiceStarting}
      >
        {voiceStarting
          ? 'Opening Jarvis…'
          : voiceActive
            ? 'Good morning, Jarvis'
            : 'Start daily brief'}
      </button>
    </section>
  )
}
