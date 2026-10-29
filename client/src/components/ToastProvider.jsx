import { useCallback, useEffect, useRef, useState } from 'react'
import { ToastContext } from '../toast.js'
import Icon from './Icon.jsx'

const DURATION_MS = 4500
const ICONS = { success: 'check', error: 'alert', info: 'spark' }

// Provides notify() to the app and shows toasts in a polite live region
function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const nextId = useRef(1)
  const timers = useRef(new Map())

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const notify = useCallback(
    (message, { type = 'success' } = {}) => {
      const id = nextId.current++
      setToasts((current) => [...current, { id, message, type }])
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DURATION_MS)
      )
    },
    [dismiss]
  )

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach(clearTimeout)
  }, [])

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type}`}>
            <Icon name={ICONS[toast.type]} size={16} />
            <span>{toast.message}</span>
            <button
              type="button"
              className="icon-btn toast-close"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export default ToastProvider
