import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuotaModal } from '../../src/components/QuotaModal'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'execCommand')
})

describe('QuotaModal', () => {
  it('renders the exact exhausted copy and the complete real QR image', () => {
    render(<QuotaModal open onClose={vi.fn()} />)

    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
    expect(document.body.contains(screen.getByText('免费体验额度已用完。想获得更多额度，可添加微信 daquan088。'))).toBe(true)
    const qr = screen.getByRole('img', { name: '大全微信二维码' })
    expect(qr.getAttribute('src')).toBe('/assets/daquan-wechat-qr.jpg')
    expect(qr.getAttribute('width')).toBe('760')
    expect(qr.getAttribute('height')).toBe('1288')
    expect(qr.getAttribute('loading')).toBe('eager')
  })

  it('copies exactly daquan088 and provides an accessible success message', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<QuotaModal open onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '复制微信号 daquan088' }))

    expect(writeText).toHaveBeenCalledWith('daquan088')
    expect((await screen.findByRole('status')).textContent).toContain('微信号已复制')
  })

  it('falls back to a temporary textarea when navigator.clipboard is unavailable', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('navigator', {})
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    render(<QuotaModal open onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '复制微信号 daquan088' }))

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect((await screen.findByRole('status')).textContent).toContain('微信号已复制')
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '复制微信号 daquan088' }))
  })

  it('uses the textarea fallback after the Clipboard API rejects', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    render(<QuotaModal open onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '复制微信号 daquan088' }))

    expect(writeText).toHaveBeenCalledWith('daquan088')
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect((await screen.findByRole('status')).textContent).toContain('微信号已复制')
  })

  it('keeps a selectable WeChat ID and clear guidance when both copy methods fail', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
    render(<QuotaModal open onClose={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '复制微信号 daquan088' }))

    expect((await screen.findByRole('alert')).textContent).toContain('复制失败，请长按选择微信号 daquan088 手动复制')
    expect(screen.getByLabelText('可手动复制的微信号').textContent).toBe('daquan088')
  })

  it('closes with Escape and its close button', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<QuotaModal open onClose={onClose} />)

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '关闭弹窗' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
