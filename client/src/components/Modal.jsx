import { useEffect, useId, useRef } from 'react'
import Icon from './Icon.jsx'

// A native <dialog> shown as a modal: it traps focus, closes on Escape and restores focus
function Modal({ title, onClose, children, footer, size = 'medium', busy = false }) {
  const dialogRef = useRef(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    const previous = document.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      previous?.focus?.()
    }
  }, [])

  // Escape fires "cancel"; while busy (e.g. uploading) the dialog stays open
  function handleCancel(event) {
    event.preventDefault()
    if (!busy) onClose()
  }

  // A click on the backdrop lands on the dialog element itself
  function handleClick(event) {
    if (event.target === dialogRef.current && !busy) onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className={`modal modal-${size}`}
      aria-labelledby={titleId}
      onCancel={handleCancel}
      onClick={handleClick}
    >
      <div className="modal-content">
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </dialog>
  )
}

export default Modal
