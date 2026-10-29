import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon.jsx'

const GAP = 6
const EDGE = 12

// Where the popover fits next to the chip: below it when there is room, else above it (or on
// the side with more room), shifted to stay fully inside the viewport
function placePopover(chip, width, height) {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const left = Math.min(Math.max(EDGE, chip.left), viewportWidth - width - EDGE)
  const roomBelow = viewportHeight - chip.bottom - GAP - EDGE
  const roomAbove = chip.top - GAP - EDGE
  const below = height <= roomBelow || (height > roomAbove && roomBelow >= roomAbove)
  const top = below ? chip.bottom + GAP : chip.top - GAP - height
  return {
    left: Math.max(EDGE, left),
    top: Math.min(Math.max(EDGE, top), viewportHeight - height - EDGE),
    placement: below ? 'below' : 'above',
  }
}

// A numbered chip for a citation [n]; clicking it shows the cited excerpt in a popover. The
// popover is rendered at the end of the page body, so the scrolling chat panel does not clip it
// and it is above all panels. Esc, the close button, a click outside or on the chip again close
// it, and focus goes back to the chip.
function CitationChip({ source, onOpenSource }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(null)
  const chipRef = useRef(null)
  const popoverRef = useRef(null)
  const popoverId = useId()
  const titleId = useId()

  function close({ focusChip = true } = {}) {
    setOpen(false)
    if (focusChip) chipRef.current?.focus({ preventScroll: true })
  }

  // Measured while hidden, then placed
  useLayoutEffect(() => {
    if (!open) return
    const popover = popoverRef.current
    setPosition(
      placePopover(chipRef.current.getBoundingClientRect(), popover.offsetWidth, popover.offsetHeight)
    )
  }, [open])

  // Once placed (and visible) it takes the focus, so screen readers announce it
  const placed = Boolean(position)
  useEffect(() => {
    if (open && placed) popoverRef.current?.focus({ preventScroll: true })
  }, [open, placed])

  useEffect(() => {
    if (!open) return
    function handlePointer(event) {
      if (popoverRef.current?.contains(event.target) || chipRef.current.contains(event.target)) return
      // Focus stays on what was clicked; it only goes back to the chip when it would be lost
      setOpen(false)
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) chipRef.current?.focus({ preventScroll: true })
      })
    }
    function handleKey(event) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      chipRef.current?.focus({ preventScroll: true })
    }
    // Scrolling inside the popover keeps it open; scrolling the page or chat closes it, because
    // the chip moves away from it
    function handleScroll(event) {
      if (!popoverRef.current?.contains(event.target)) setOpen(false)
    }
    function handleResize() {
      setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointer)
    document.addEventListener('keydown', handleKey)
    window.addEventListener('resize', handleResize)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointer)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`citation-chip${open ? ' is-open' : ''}`}
        onClick={() => {
          setPosition(null)
          setOpen((value) => !value)
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popoverId : undefined}
        aria-label={`Source ${source.n}: ${source.title}`}
      >
        {source.n}
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            className="citation-popover"
            role="dialog"
            aria-labelledby={titleId}
            tabIndex={-1}
            data-placement={position?.placement}
            style={position ? { left: position.left, top: position.top } : { visibility: 'hidden' }}
          >
            <div className="citation-popover-header">
              <span className="citation-popover-number" aria-hidden="true">
                {source.n}
              </span>
              <strong id={titleId} className="citation-popover-title">
                {source.title}
              </strong>
              <button
                type="button"
                className="icon-btn citation-popover-close"
                onClick={() => close()}
                aria-label="Close"
                title="Close (Esc)"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <p className="citation-popover-excerpt">{source.text}</p>
            <div className="citation-popover-footer">
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  close({ focusChip: false })
                  onOpenSource(source.materialId)
                }}
              >
                <Icon name="open" size={14} />
                Open source
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

export default CitationChip
