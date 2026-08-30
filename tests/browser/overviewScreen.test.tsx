import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { OverviewSuccessPayload } from '../../shared/contracts'
import { OverviewScreen } from '../../src/components/OverviewScreen'

const image = { previewUrl: 'blob:overview', dataUrl: 'data:image/jpeg;base64,AAA', width: 1000, height: 2000, blob: new Blob(), revoke: vi.fn() }
const overview: OverviewSuccessPayload = { variety: 'thai-monthong', image_quality: 'usable', warnings: ['2号有遮挡'], fruits: [
  { id: 1, box_2d: [100, 200, 500, 700], status: 'preferred', visibility: 'high', evidence: ['果形均匀'], risks: [], evidence_strength: 'high' },
  { id: 2, box_2d: [500, 100, 900, 400], status: 'risky', visibility: 'medium', evidence: ['可见果刺'], risks: ['局部遮挡'], evidence_strength: 'medium' },
], shortlist_ids: [1, 2], taskToken: 'token', remaining: 4 }

describe('OverviewScreen', () => {
  it('maps portrait image boxes in the exact image coordinate system and shows only returned fruit labels', () => {
    render(<OverviewScreen image={image} overview={overview} onContinue={vi.fn()} onRestart={vi.fn()} />)
    const box = screen.getByTestId('fruit-box-1')
    expect(box.getAttribute('x')).toBe('200')
    expect(box.getAttribute('y')).toBe('200')
    expect(box.getAttribute('width')).toBe('500')
    expect(box.getAttribute('height')).toBe('800')
    expect(screen.getAllByText('1号').length).toBeGreaterThan(0)
    expect(screen.queryByText('3号')).toBeNull()
    expect(document.body.contains(screen.getByText('识别到 2 颗；未识别或遮挡严重的榴莲不参与推荐'))).toBe(true)
  })

  it('starts with shortlist selections and prevents selecting more than three', async () => {
    const user = userEvent.setup()
    const larger = { ...overview, fruits: [1, 2, 3, 4].map((id) => ({ ...overview.fruits[0]!, id })), shortlist_ids: [1, 2, 3, 4] }
    render(<OverviewScreen image={image} overview={larger} onContinue={vi.fn()} onRestart={vi.fn()} />)
    const checks = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(checks[0]?.checked).toBe(true)
    await user.click(checks[0]!)
    await user.click(checks[3]!)
    await user.click(checks[0]!)
    expect(document.body.contains(screen.getByText('最多选择 3 颗候选榴莲。'))).toBe(true)
  })
})
