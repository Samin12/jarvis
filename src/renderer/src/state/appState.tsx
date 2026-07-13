import { createContext, useContext, useReducer } from 'react'
import type { Dispatch, ReactNode } from 'react'
import type {
  AuthStatus,
  CodexEventRow,
  CodexTaskRow,
  ConnectorCard,
  CoreMode,
  TranscriptEntry,
  VoiceLane
} from '../../../shared/types'

// ---------------------------------------------------------------------------
// APP STATE — the shared store every feature dispatches into. Pure state:
// no IPC here (features own their own IPC hooks and dispatch results in).
// ---------------------------------------------------------------------------

export interface AppState {
  auth: AuthStatus
  coreMode: CoreMode
  voiceLane: VoiceLane
  transcript: TranscriptEntry[]
  connectors: ConnectorCard[]
  codexTasks: CodexTaskRow[]
}

export const initialAppState: AppState = {
  auth: { state: 'signed_out' },
  coreMode: 'idle',
  voiceLane: 'fallback',
  transcript: [],
  connectors: [],
  codexTasks: []
}

export type AppAction =
  | { type: 'auth/set'; status: AuthStatus }
  | { type: 'core/setMode'; mode: CoreMode }
  | { type: 'voice/setLane'; lane: VoiceLane }
  | { type: 'transcript/append'; entry: TranscriptEntry }
  | { type: 'transcript/update'; id: string; patch: Partial<Omit<TranscriptEntry, 'id'>> }
  | { type: 'transcript/reset' }
  | { type: 'connectors/set'; cards: ConnectorCard[] }
  | { type: 'connectors/upsert'; card: ConnectorCard }
  | { type: 'codex/setTasks'; tasks: CodexTaskRow[] }
  | { type: 'codex/upsertTask'; task: CodexTaskRow }
  | { type: 'codex/appendEvent'; taskId: string; row: CodexEventRow }

const TRANSCRIPT_CAP = 500

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'auth/set':
      return { ...state, auth: action.status }

    case 'core/setMode':
      return state.coreMode === action.mode ? state : { ...state, coreMode: action.mode }

    case 'voice/setLane':
      return state.voiceLane === action.lane ? state : { ...state, voiceLane: action.lane }

    case 'transcript/append': {
      const next = [...state.transcript, action.entry]
      return {
        ...state,
        transcript: next.length > TRANSCRIPT_CAP ? next.slice(-TRANSCRIPT_CAP) : next
      }
    }

    case 'transcript/update':
      return {
        ...state,
        transcript: state.transcript.map((e) =>
          e.id === action.id ? { ...e, ...action.patch, id: e.id } : e
        )
      }

    case 'transcript/reset':
      return { ...state, transcript: [] }

    case 'connectors/set':
      return { ...state, connectors: action.cards }

    case 'connectors/upsert': {
      const exists = state.connectors.some((c) => c.slug === action.card.slug)
      return {
        ...state,
        connectors: exists
          ? state.connectors.map((c) => (c.slug === action.card.slug ? action.card : c))
          : [...state.connectors, action.card]
      }
    }

    case 'codex/setTasks':
      return { ...state, codexTasks: action.tasks }

    case 'codex/upsertTask': {
      const exists = state.codexTasks.some((t) => t.taskId === action.task.taskId)
      return {
        ...state,
        codexTasks: exists
          ? state.codexTasks.map((t) => (t.taskId === action.task.taskId ? action.task : t))
          : [...state.codexTasks, action.task]
      }
    }

    case 'codex/appendEvent':
      return {
        ...state,
        codexTasks: state.codexTasks.map((t) =>
          t.taskId === action.taskId ? { ...t, events: [...t.events, action.row] } : t
        )
      }

    default:
      return state
  }
}

const StateCtx = createContext<AppState>(initialAppState)
const DispatchCtx = createContext<Dispatch<AppAction>>(() => undefined)

export function AppStateProvider({
  children,
  initial
}: {
  children: ReactNode
  initial?: Partial<AppState>
}): React.JSX.Element {
  const [state, dispatch] = useReducer(appReducer, { ...initialAppState, ...initial })
  return (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider value={dispatch}>{children}</DispatchCtx.Provider>
    </StateCtx.Provider>
  )
}

export function useAppState(): AppState {
  return useContext(StateCtx)
}

export function useAppDispatch(): Dispatch<AppAction> {
  return useContext(DispatchCtx)
}
