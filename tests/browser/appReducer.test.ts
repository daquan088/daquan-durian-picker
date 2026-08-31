import { describe, expect, it } from 'vitest'
import type { OverviewSuccessPayload } from '../../shared/contracts'
import { appReducer, initialAppState } from '../../src/app/appReducer'

const overviewPayload: OverviewSuccessPayload = {
  variety: 'thai-monthong',
  image_quality: 'good',
  warnings: [],
  fruits: [1, 2, 3, 4].map((id) => ({
    id,
    box_2d: [0, 0, 100, 100] as [number, number, number, number],
    status: 'normal' as const,
    visibility: 'high' as const,
    evidence: ['果形完整'],
    risks: [],
    evidence_strength: 'high' as const,
  })),
  shortlist_ids: [1, 2, 3, 4],
  taskToken: 'task-token',
  remaining: 4,
}

function toShortlist() {
  return appReducer(
    appReducer(initialAppState, { type: 'START_OVERVIEW' }),
    { type: 'OVERVIEW_SUCCESS', payload: overviewPayload },
  )
}

describe('appReducer', () => {
  it('rejects more than one candidate ID without changing state', () => {
    const state = toShortlist()
    const next = appReducer(state, { type: 'SELECT_CANDIDATES', ids: [1, 2, 3, 4] })

    expect(next).toBe(state)
  })

  it('safely rejects repeated, unknown, and illegal transitions', () => {
    const state = toShortlist()
    expect(appReducer(state, { type: 'START_OVERVIEW' })).toBe(state)
    expect(appReducer(state, { type: 'SELECT_CANDIDATES', ids: [99] })).toBe(state)
    expect(appReducer(state, { type: 'SELECT_CANDIDATES', ids: [1, 1] })).toBe(state)
    expect(appReducer(initialAppState, { type: 'OVERVIEW_SUCCESS', payload: overviewPayload })).toBe(initialAppState)
  })

  it('copies incoming arrays so caller mutation cannot change app state', () => {
    const state = toShortlist()
    const chosen = [2]
    const next = appReducer(state, { type: 'SELECT_CANDIDATES', ids: chosen })
    chosen[0] = 99

    expect(next.selectedCandidateIds).toEqual([2])
  })

  it('returns from the candidate camera to the existing shortlist without losing the task', () => {
    const shortlist = toShortlist()
    const capture = appReducer(shortlist, { type: 'SELECT_CANDIDATES', ids: [1] })
    expect(appReducer(capture, { type: 'BACK_TO_SHORTLIST' })).toMatchObject({ screen: 'shortlist', overview: overviewPayload })
  })
})
