import Icon from './Icon.jsx'

// A readable error message with an optional retry button
function ErrorState({ message, onRetry, compact = false }) {
  return (
    <div className={`error-state${compact ? ' error-state-compact' : ''}`} role="alert">
      <Icon name="alert" size={compact ? 16 : 20} />
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          <Icon name="refresh" size={14} />
          Retry
        </button>
      )}
    </div>
  )
}

export default ErrorState
