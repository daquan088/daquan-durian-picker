import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App, type QuotaLoader } from '../../src/app/App'
import { AppError } from '../../src/lib/api'
import type { ProcessedImage } from '../../src/lib/imageProcessing'

describe('App quota loading', () => {
  it('opens the hidden overview file picker from the home CTA, retains one key for retry, and does not interrupt the fifth completed task', async () => {
    const user = userEvent.setup()
    const processed: ProcessedImage = { blob: new Blob(), dataUrl: 'data:image/jpeg;base64,AAA', width: 100, height: 100, previewUrl: 'blob:overview', revoke: vi.fn() }
    let rejectFirst!: (error: Error) => void
    const success = { variety: 'thai-monthong' as const, image_quality: 'poor' as const, warnings: ['画面模糊，建议重拍'], fruits: [{ id: 1, box_2d: [0, 0, 500, 500] as [number, number, number, number], status: 'normal' as const, visibility: 'medium' as const, evidence: ['果形可见'], risks: [], evidence_strength: 'medium' as const }], shortlist_ids: [1], taskToken: 'task', remaining: 0 }
    const overviewLoader = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject })).mockResolvedValueOnce(success)
    const { container } = render(<App quotaLoader={async () => ({ remaining: 2 })} overviewImageProcessor={async () => processed} overviewLoader={overviewLoader} />)
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    await user.click(await screen.findByRole('button', { name: '拍照开始选榴莲' }))
    await waitFor(() => expect(click).toHaveBeenCalled())
    const picker = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(picker, { target: { files: [new File(['x'], 'durian.jpg', { type: 'image/jpeg' })] } })
    expect(document.body.contains(await screen.findByText('正在识别可见榴莲…'))).toBe(true)
    rejectFirst(new AppError('PROVIDER_FAILURE', 'AI 服务暂时不可用。'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('AI 服务暂时不可用。'))
    await user.click(screen.getByRole('button', { name: '重试分析' }))
    await waitFor(() => expect(overviewLoader).toHaveBeenCalledTimes(2))
    expect(overviewLoader.mock.calls[0]![1].idempotencyKey).toBe(overviewLoader.mock.calls[1]![1].idempotencyKey)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('retries after an initial failure and clears the error after recovery', async () => {
    const user = userEvent.setup()
    const quotaLoader: QuotaLoader = vi.fn()
      .mockRejectedValueOnce(new AppError('NETWORK_ERROR', '网络暂时不可用'))
      .mockResolvedValueOnce({ remaining: 3 })

    render(<App quotaLoader={quotaLoader} />)
    expect((await screen.findByRole('alert')).textContent).toContain('网络暂时不可用')

    await user.click(screen.getByRole('button', { name: '重新获取' }))

    expect(document.body.contains(await screen.findByText('剩余体验 3 次'))).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByRole('button', { name: '拍照开始选榴莲' }) as HTMLButtonElement).disabled).toBe(false)
    expect(quotaLoader).toHaveBeenCalledTimes(2)
  })

  it('aborts the active quota request on unmount without applying its result', async () => {
    let resolveRequest!: (value: { remaining: number }) => void
    let requestSignal: AbortSignal | undefined
    const quotaLoader: QuotaLoader = vi.fn((options) => {
      requestSignal = options.signal
      return new Promise<{ remaining: number }>((resolve) => { resolveRequest = resolve })
    })
    const { unmount } = render(<App quotaLoader={quotaLoader} />)

    unmount()
    expect(requestSignal?.aborted).toBe(true)
    await act(async () => resolveRequest({ remaining: 2 }))
  })

  it('ignores a stale quota response when a newer request has already completed', async () => {
    const resolvers: Array<(value: { remaining: number }) => void> = []
    const quotaLoader: QuotaLoader = vi.fn(() => new Promise<{ remaining: number }>((resolve) => { resolvers.push(resolve) }))

    render(<StrictMode><App quotaLoader={quotaLoader} /></StrictMode>)
    await waitFor(() => expect(quotaLoader).toHaveBeenCalledTimes(2))

    await act(async () => resolvers[1]({ remaining: 4 }))
    expect(document.body.contains(await screen.findByText('剩余体验 4 次'))).toBe(true)
    await act(async () => resolvers[0]({ remaining: 0 }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('剩余体验 4 次').textContent).toBe('剩余体验 4 次')
  })
})
