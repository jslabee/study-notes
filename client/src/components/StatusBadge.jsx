const LABELS = { processing: 'Processing', ready: 'Ready', error: 'Error' }

// Processing shows a spinner; Error shows its message on hover and keyboard focus
function StatusBadge({ status, error }) {
  if (status === 'error') {
    const message = error || 'Processing failed.'
    return (
      <span className="badge badge-error tooltip" tabIndex={0} aria-label={`Error: ${message}`}>
        Error
        <span className="tooltip-bubble" role="tooltip">
          {message}
        </span>
      </span>
    )
  }
  return (
    <span className={`badge badge-${status}`}>
      {status === 'processing' && <span className="spinner" aria-hidden="true" />}
      {LABELS[status] ?? status}
    </span>
  )
}

export default StatusBadge
