import type { FinalRankingSuccessPayload, OverviewSuccessPayload } from '../../shared/contracts'

export type Screen = 'home' | 'overview' | 'shortlist' | 'capture' | 'final'

export interface AppState {
  screen: Screen
  overview: OverviewSuccessPayload | null
  selectedCandidateIds: readonly number[]
  finalResult: FinalRankingSuccessPayload | null
}

export type AppAction =
  | { type: 'START_OVERVIEW' }
  | { type: 'OVERVIEW_SUCCESS'; payload: OverviewSuccessPayload }
  | { type: 'SELECT_CANDIDATES'; ids: readonly number[] }
  | { type: 'CANDIDATES_SUCCESS'; payload: FinalRankingSuccessPayload }
  | { type: 'RESET' }

export const initialAppState: AppState = {
  screen: 'home',
  overview: null,
  selectedCandidateIds: [],
  finalResult: null,
}

function copyOverview(payload: OverviewSuccessPayload): OverviewSuccessPayload {
  return {
    ...payload,
    warnings: [...payload.warnings],
    fruits: payload.fruits.map((fruit) => ({
      ...fruit,
      box_2d: [...fruit.box_2d] as typeof fruit.box_2d,
      evidence: [...fruit.evidence],
      risks: [...fruit.risks],
    })),
    shortlist_ids: [...payload.shortlist_ids],
  }
}

function copyFinalResult(payload: FinalRankingSuccessPayload): FinalRankingSuccessPayload {
  return {
    ...payload,
    result: {
      ...payload.result,
      ranking: payload.result.ranking.map((item) => ({ ...item, evidence: [...item.evidence], risks: [...item.risks] })),
      limitations: [...payload.result.limitations],
    },
  }
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'START_OVERVIEW':
      return state.screen === 'home' ? { ...state, screen: 'overview' } : state

    case 'OVERVIEW_SUCCESS':
      return state.screen === 'overview'
        ? { screen: 'shortlist', overview: copyOverview(action.payload), selectedCandidateIds: [], finalResult: null }
        : state

    case 'SELECT_CANDIDATES': {
      if (state.screen !== 'shortlist' || state.overview === null) return state
      const ids = [...action.ids]
      const knownIds = new Set(state.overview.fruits.filter((fruit) => fruit.status !== 'insufficient').map((fruit) => fruit.id))
      if (ids.length === 0 || ids.length > 3 || new Set(ids).size !== ids.length || ids.some((id) => !knownIds.has(id))) return state
      return { ...state, screen: 'capture', selectedCandidateIds: ids }
    }

    case 'CANDIDATES_SUCCESS':
      return state.screen === 'capture' && state.selectedCandidateIds.length > 0
        ? { ...state, screen: 'final', finalResult: copyFinalResult(action.payload) }
        : state

    case 'RESET':
      return initialAppState
  }
}
