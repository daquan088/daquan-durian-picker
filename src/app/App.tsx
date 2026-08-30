import { useCallback, useEffect, useReducer, useState } from 'react'
import { HomeScreen } from '../components/HomeScreen'
import { QuotaModal } from '../components/QuotaModal'
import { isAppError, requestQuota } from '../lib/api'
import { appReducer, initialAppState } from './appReducer'

export function App() {
  const [, dispatch] = useReducer(appReducer, initialAppState)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [quotaLoading, setQuotaLoading] = useState(true)
  const [quotaError, setQuotaError] = useState<string | null>(null)
  const [quotaModalOpen, setQuotaModalOpen] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const loadQuota = async () => {
      setQuotaLoading(true)
      setQuotaError(null)
      try {
        const quota = await requestQuota({ signal: controller.signal })
        if (!active) return
        setRemaining(quota.remaining)
        setQuotaModalOpen(quota.remaining === 0)
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return
        if (isAppError(error) && error.code === 'QUOTA_EXHAUSTED') setQuotaModalOpen(true)
        setQuotaError(isAppError(error) ? error.message : '体验次数暂时无法获取，请稍后重试。')
      } finally {
        if (active) setQuotaLoading(false)
      }
    }
    void loadQuota()
    return () => {
      active = false
      controller.abort()
    }
  }, [])

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
      />
      <QuotaModal open={quotaModalOpen} onClose={closeQuotaModal} />
    </>
  )
}
