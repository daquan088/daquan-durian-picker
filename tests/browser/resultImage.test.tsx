import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toPng } from 'html-to-image'
import type { FinalRankingSuccessPayload, OverviewSuccessPayload } from '../../shared/contracts'
import { FinalResult, FINAL_DISCLAIMER } from '../../src/components/FinalResult'
import { exportResultImage, RESULT_IMAGE_FILENAME } from '../../src/lib/resultImage'

vi.mock('html-to-image', () => ({ toPng: vi.fn() }))

const png = 'data:image/png;base64,UE5H'
const result: FinalRankingSuccessPayload = { variety: 'thai-monthong', result: { ranking: [{ candidate_id: 1, rank: 1, appearance_score: 91, evidence: ['果形匀称'], risks: [], evidence_strength: 'high' }], summary: '优先选择 1 号。', limitations: ['照片光线会影响判断'] } }
const overview: OverviewSuccessPayload = {
  variety: 'thai-monthong',
  image_quality: 'good',
  warnings: [],
  fruits: [{ id: 1, box_2d: [100, 120, 700, 760], status: 'preferred', visibility: 'high', evidence: ['果形匀称'], risks: [], evidence_strength: 'high' }],
  shortlist_ids: [1],
  taskToken: 'task-token',
  remaining: 4,
}
const overviewImage = { dataUrl: 'data:image/jpeg;base64,T1ZFUlZJRVc=', width: 1200, height: 1600 }
const mockedToPng = vi.mocked(toPng)

function shareNavigator(values: Partial<Pick<Navigator, 'canShare' | 'share'>>) {
  Object.defineProperty(window.navigator, 'canShare', { configurable: true, value: values.canShare })
  Object.defineProperty(window.navigator, 'share', { configurable: true, value: values.share })
}

describe('result image export', () => {
  beforeEach(() => {
    mockedToPng.mockReset()
    mockedToPng.mockResolvedValue(png)
    shareNavigator({ canShare: undefined, share: undefined })
  })

  it('captures the dedicated result node with exact PNG settings and produces the exact file', async () => {
    const node = document.createElement('section')
    const outcome = await exportResultImage(node)
    expect(mockedToPng).toHaveBeenCalledWith(node, { pixelRatio: 2, cacheBust: true })
    expect(outcome.file.name).toBe('大全助你选金枕榴莲-结果.png')
    expect(outcome.file.type).toBe('image/png')
    expect(outcome.dataUrl).toBe(png)
    expect(outcome.kind).toBe('fallback')
  })

  it('uses the native share sheet only after canShare accepts the PNG file', async () => {
    const canShare = vi.fn(() => true)
    const share = vi.fn().mockResolvedValue(undefined)
    shareNavigator({ canShare, share })
    const outcome = await exportResultImage(document.createElement('section'))
    expect(canShare).toHaveBeenCalledWith({ files: [outcome.file] })
    expect(share).toHaveBeenCalledWith({ files: [outcome.file] })
    expect(outcome.kind).toBe('shared')
  })

  it('keeps a long-press fallback if sharing is unsupported or rejected', async () => {
    const unsupported = await exportResultImage(document.createElement('section'))
    expect(unsupported.kind).toBe('fallback')
    const share = vi.fn().mockRejectedValue(new Error('share failed'))
    shareNavigator({ canShare: vi.fn(() => true), share })
    const rejected = await exportResultImage(document.createElement('section'))
    expect(rejected.kind).toBe('fallback')
    expect(rejected.dataUrl).toBe(png)
    expect(rejected.error?.message).toBe('share failed')
  })
})

describe('FinalResult export experience', () => {
  it('captures product title, ranking and full visible-exterior declaration without controls', async () => {
    const user = userEvent.setup()
    const exportResult = vi.fn().mockResolvedValue({ kind: 'fallback', dataUrl: png, file: new File(['PNG'], RESULT_IMAGE_FILENAME, { type: 'image/png' }) })
    render(<FinalResult result={result} overview={overview} overviewImage={overviewImage} onRestart={vi.fn()} exportResult={exportResult} />)
    await user.click(screen.getByRole('button', { name: '保存或分享结果' }))
    const capture = exportResult.mock.calls[0]![0] as HTMLElement
    expect(capture.textContent).toContain('大全助你选金枕榴莲')
    expect(capture.textContent).toContain('第一推荐 · 1号')
    expect(capture.textContent).toContain(FINAL_DISCLAIMER)
    expect(capture.textContent).not.toContain('保存或分享结果')
    expect(capture.querySelector('img[alt="带编号的榴莲合照"]')?.getAttribute('src')).toBe(overviewImage.dataUrl)
    expect(capture.querySelector('[data-testid="fruit-box-1"]')).not.toBeNull()
    expect(document.body.contains(screen.getByText('长按保存结果图'))).toBe(true)
    expect(screen.getByRole('img', { name: '可长按保存的榴莲挑选结果图' }).getAttribute('src')).toBe(png)
  })

  it('keeps the fallback image when share fails and allows closing or regenerating it', async () => {
    const user = userEvent.setup()
    const exportResult = vi.fn().mockResolvedValue({ kind: 'fallback', dataUrl: png, file: new File(['PNG'], RESULT_IMAGE_FILENAME, { type: 'image/png' }), error: new Error('share failed') })
    render(<FinalResult result={result} overview={overview} overviewImage={overviewImage} onRestart={vi.fn()} exportResult={exportResult} />)
    await user.click(screen.getByRole('button', { name: '保存或分享结果' }))
    expect(screen.getByRole('status').textContent).toBe('分享未完成，已生成可保存的结果图。')
    await user.click(screen.getByRole('button', { name: '关闭结果图预览' }))
    expect(screen.queryByText('长按保存结果图')).toBeNull()
    await user.click(screen.getByRole('button', { name: '重新生成结果图' }))
    expect(exportResult).toHaveBeenCalledTimes(2)
  })

  it('prevents duplicate exports and discards a delayed result after unmount', async () => {
    const user = userEvent.setup()
    type FallbackOutcome = { kind: 'fallback'; dataUrl: string; file: File }
    let resolveExport!: (value: FallbackOutcome) => void
    const exportResult = vi.fn(() => new Promise<FallbackOutcome>((resolve) => { resolveExport = resolve }))
    const { unmount } = render(<FinalResult result={result} overview={overview} overviewImage={overviewImage} onRestart={vi.fn()} exportResult={exportResult} />)
    const save = screen.getByRole('button', { name: '保存或分享结果' })
    await user.click(save)
    await user.click(save)
    expect(exportResult).toHaveBeenCalledTimes(1)
    unmount()
    await act(async () => resolveExport({ kind: 'fallback', dataUrl: png, file: new File(['PNG'], RESULT_IMAGE_FILENAME, { type: 'image/png' }) }))
  })
})
