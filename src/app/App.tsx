import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { HomeScreen } from '../components/HomeScreen'
import { QuotaModal } from '../components/QuotaModal'
import { isAppError, requestQuota } from '../lib/api'
import { appReducer, initialAppState } from './appReducer'

export type QuotaLoader = (options: { signal: AbortSignal }) => Promise<{ remaining: number }>

export interface AppProps {
  quotaLoader?: QuotaLoader
}

export function App({ quotaLoader = requestQuota }: AppProps) {
  const [, dispatch] = useReducer(appReducer, initialAppState)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [quotaLoading, setQuotaLoading] = useState(true)
  const [quotaError, setQuotaError] = useState<string | null>(null)
  const [quotaModalOpen, setQuotaModalOpen] = useState(false)
  const mountedRef = useRef(false)
  const requestSequenceRef = useRef(0)
  const activeControllerRef = useRef<AbortController | null>(null)

  const loadQuota = useCallback(async () => {
    const sequence = ++requestSequenceRef.current
    activeControllerRef.current?.abort()
    const controller = new AbortController()
    activeControllerRef.current = controller
    setQuotaLoading(true)
    setQuotaError(null)
    try {
      const quota = await quotaLoader({ signal: controller.signal })
      if (!mountedRef.current || sequence !== requestSequenceRef.current) return
      setRemaining(quota.remaining)
      setQuotaModalOpen(quota.remaining === 0)
    } catch (error) {
      if (!mountedRef.current || sequence !== requestSequenceRef.current || (error instanceof DOMException && error.name === 'AbortError')) return
      if (isAppError(error) && error.code === 'QUOTA_EXHAUSTED') setQuotaModalOpen(true)
      setQuotaError(isAppError(error) ? error.message : '体验次数暂时无法获取，请稍后重试。')
    } finally {
      if (mountedRef.current && sequence === requestSequenceRef.current) {
        setQuotaLoading(false)
        if (activeControllerRef.current === controller) activeControllerRef.current = null
      }
    }
  }, [quotaLoader])

  useEffect(() => {
    mountedRef.current = true
    void loadQuota()
    return () => {
      mountedRef.current = false
      requestSequenceRef.current += 1
      activeControllerRef.current?.abort()
      activeControllerRef.current = null
    }
  }, [loadQuota])

  const canStart = !quotaLoading && remaining !== null && remaining > 0
  const startOverview = () => {
    if (!canStart) return
    dispatch({ type: 'START_OVERVIEW' })
  }
  const closeQuotaModal = useCallback(() => setQuotaModalOpen(false), [])

  return (
    <>
      <HomeScreen
        remaining={remaining}
        quotaLoading={quotaLoading}
        quotaError={quotaError}
        canStart={canStart}
        onStart={startOverview}
        onRetryQuota={() => { void loadQuota() }}
      />
      <QuotaModal open={quotaModalOpen} onClose={closeQuotaModal} />
    </>
  )
}
