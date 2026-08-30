import { StrictMode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App, type QuotaLoader } from '../../src/app/App'
import { AppError } from '../../src/lib/api'

describe('App quota loading', () => {
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
