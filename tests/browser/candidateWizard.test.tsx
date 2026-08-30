import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ProcessedImage } from '../../src/lib/imageProcessing'
import { CandidateWizard } from '../../src/components/CandidateWizard'
import { FINAL_DISCLAIMER, FinalResult } from '../../src/components/FinalResult'

function processed(id: string): ProcessedImage { return { blob: new Blob(), dataUrl: `data:image/jpeg;base64,${id}`, width: 10, height: 10, previewUrl: `blob:${id}`, revoke: vi.fn() } }
const file = new File(['jpeg'], 'test.jpg', { type: 'image/jpeg' })

describe('CandidateWizard', () => {
  it('requires the three fixed views for every candidate and sends photos under their correct candidate IDs', async () => {
    const user = userEvent.setup()
    let count = 0
    const processor = vi.fn(async () => processed(String(++count)))
    const submit = vi.fn(async () => ({ variety: 'thai-monthong' as const, result: { ranking: [{ candidate_id: 1, rank: 1, appearance_score: 88, evidence: ['完整'], risks: [], evidence_strength: 'high' as const }], summary: '建议', limitations: ['仅外观'] } })) as unknown as (payload: import('../../shared/contracts').CandidateFollowUpPayload, options: { signal: AbortSignal; idempotencyKey: string }) => Promise<import('../../shared/contracts').FinalRankingSuccessPayload>
    render(<CandidateWizard selectedIds={[1, 2, 3]} taskToken="task" imageProcessor={processor} submit={submit} onSuccess={vi.fn()} onBack={vi.fn()} />)
    expect((screen.getByRole('button', { name: '提交补拍并生成建议' }) as HTMLButtonElement).disabled).toBe(true)
    for (const id of [1, 2, 3]) {
      await user.click(screen.getByRole('tab', { name: `${id}号` }))
      for (const view of ['stem', 'body', 'bottom']) { fireEvent.change(document.getElementById(`capture-${id}-${view}`)!, { target: { files: [file] } }); await waitFor(() => expect(processor).toHaveBeenCalledTimes((id - 1) * 3 + ['stem', 'body', 'bottom'].indexOf(view) + 1)) }
      await waitFor(() => expect(processor).toHaveBeenCalledTimes(id * 3))
    }
    await user.click(screen.getByRole('button', { name: '提交补拍并生成建议' }))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    const payload = (submit as unknown as { mock: { calls: [import('../../shared/contracts').CandidateFollowUpPayload, { idempotencyKey: string }][] } }).mock.calls[0]![0]
    expect(payload.candidates.map((candidate: { candidate_id: number }) => candidate.candidate_id)).toEqual([1, 2, 3])
    expect(payload.candidates[1].stem).toContain('4')
    expect((submit as unknown as { mock: { calls: [unknown, { idempotencyKey: string }][] } }).mock.calls[0]![1].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reuses the submit idempotency key after a transient failure and revokes replaced previews', async () => {
    const user = userEvent.setup()
    const first = processed('first'); const replacement = processed('replacement')
    const processor = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replacement).mockResolvedValue(processed('other'))
    const submit = vi.fn().mockRejectedValueOnce(new Error('网络错误')).mockResolvedValue({ variety: 'thai-monthong', result: { ranking: [{ candidate_id: 1, rank: 1, appearance_score: 80, evidence: ['完整'], risks: [], evidence_strength: 'high' }], summary: '建议', limitations: ['仅外观'] } })
    const { unmount } = render(<CandidateWizard selectedIds={[1]} taskToken="task" imageProcessor={processor} submit={submit} onSuccess={vi.fn()} onBack={vi.fn()} />)
    for (const [index, view] of ['stem', 'body', 'bottom'].entries()) { fireEvent.change(document.getElementById(`capture-1-${view}`)!, { target: { files: [file] } }); await waitFor(() => expect(processor).toHaveBeenCalledTimes(index + 1)) }
    fireEvent.change(document.getElementById('capture-1-stem')!, { target: { files: [file] } })
    await waitFor(() => expect(first.revoke).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: '提交补拍并生成建议' }))
    await waitFor(() => expect(document.body.contains(screen.getByRole('alert'))).toBe(true))
    await user.click(screen.getByRole('button', { name: '重新获取' }))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
    const calls = (submit as unknown as { mock: { calls: [unknown, { idempotencyKey: string }][] } }).mock.calls
    expect(calls[0]![1].idempotencyKey).toBe(calls[1]![1].idempotencyKey)
    unmount(); expect(replacement.revoke).toHaveBeenCalledTimes(1)
  })

  it('renders continuous ranks and the fixed exterior-only declaration', () => {
    render(<FinalResult onRestart={vi.fn()} result={{ variety: 'thai-monthong', result: { ranking: [
      { candidate_id: 2, rank: 2, appearance_score: 75, evidence: ['证据'], risks: [], evidence_strength: 'medium' },
      { candidate_id: 1, rank: 1, appearance_score: 90, evidence: ['证据'], risks: [], evidence_strength: 'high' },
    ], summary: '总结', limitations: ['限制'] } }} />)
    expect(document.body.contains(screen.getByText('第一推荐 · 1号'))).toBe(true); expect(document.body.contains(screen.getByText('备选 1 · 2号'))).toBe(true); expect(document.body.contains(screen.getByText(FINAL_DISCLAIMER))).toBe(true)
  })
})
