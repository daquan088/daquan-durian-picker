import { useEffect, useId, useRef, useState } from 'react'

export interface QuotaModalProps {
  open: boolean
  onClose: () => void
}

function copyWithTextarea(value: string): boolean {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.readOnly = true
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.position = 'fixed'
  textarea.style.inset = '0 auto auto -9999px'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  try {
    textarea.focus()
    textarea.select()
    return typeof document.execCommand === 'function' && document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
    previousFocus?.focus()
  }
}

export function QuotaModal({ open, onClose }: QuotaModalProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'failure'>('idle')

  useEffect(() => {
    if (!open) return
    setCopyState('idle')
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab' || dialogRef.current === null) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('hidden'))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = originalOverflow
      document.removeEventListener('keydown', onKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [onClose, open])

  if (!open) return null

  const copyWechat = async () => {
    const wechatId = 'daquan088'
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(wechatId)
        setCopyState('success')
        return
      } catch {
        // Older WebViews can expose Clipboard API but reject it; use the DOM fallback.
      }
    }
    if (copyWithTextarea(wechatId)) {
      setCopyState('success')
      return
    }
    setCopyState('failure')
  }

  return (
    <div className="quota-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} className="quota-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <button ref={closeButtonRef} className="icon-button quota-close" type="button" onClick={onClose} aria-label="关闭弹窗">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
        <h2 id={titleId}>免费体验额度已用完</h2>
        <p>免费体验额度已用完。想获得更多额度，可添加微信 daquan088。</p>
        <button className="primary-button" type="button" onClick={copyWechat}>复制微信号 daquan088</button>
        {copyState === 'success' ? <p className="copy-feedback" role="status">微信号已复制</p> : null}
        {copyState === 'failure' ? (
          <p className="copy-feedback copy-feedback--error" role="alert">
            复制失败，请长按选择微信号 <span className="manual-wechat-id" aria-label="可手动复制的微信号">daquan088</span> 手动复制
          </p>
        ) : null}
        <div className="qr-container">
          <img src="/assets/daquan-wechat-qr.jpg" alt="大全微信二维码" width={760} height={1288} loading="eager" />
        </div>
        <p className="qr-help">长按识别二维码添加好友</p>
      </section>
    </div>
  )
}
