export interface ErrorPanelProps {
  message: string
  onRetry?: () => void
}

export function ErrorPanel({ message, onRetry }: ErrorPanelProps) {
  return (
    <section className="error-panel" role="alert">
      <p>{message}</p>
      {onRetry ? <button className="secondary-button" type="button" onClick={onRetry}>重新获取</button> : null}
    </section>
  )
}
