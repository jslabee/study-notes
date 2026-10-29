import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'

const POPOVER_WIDTH = 340
const GAP = 6
const EDGE = 12

// A numbered chip for a citation [n]; clicking it shows the cited excerpt in a popover.
// The popover is fixed to the viewport, so the scrolling chat panel does not clip it.
function CitationChip({ source, onOpenSource }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(null)
  const chipRef = useRef(null)
  const popoverRef = useRef(null)
  const popoverId = useId()

  useLayoutEffect(() => {
    if (!open) return
    const chip = chipRef.current.getBoundingClientRect()
    const width = Math.min(POPOVER_WIDTH, window.innerWidth - 2 * EDGE)
    const left = Math.min(Math.max(EDGE, chip.left), window.innerWidth - width - EDGE)
    const height = popoverRef.current.offsetHeight
    // Below the chip when there is room, otherwise above it
    const below = chip.bottom + GAP + height <= window.innerHeight - EDGE
    const top = below ? chip.bottom + GAP : Math.max(EDGE, chip.top - GAP - height)
    setPosition({ left, top, width })
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    function handlePointer(event) {
      if (!popoverRef.current?.contains(event.target) && !chipRef.current.contains(event.target)) {
        close()
      }
    }
    function handleKey(event) {
      if (event.key === 'Escape') {
        close()
        chipRef.current.focus()
      }
    }
    // Scrolling inside the popover keeps it open; scrolling the page or chat closes it
    function handleScroll(event) {
      if (!popoverRef.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', handlePointer)
    document.addEventListener('keydown', handleKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointer)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('resize', close)
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
        aria-controls={open ? popoverId : undefined}
        aria-label={`Source ${source.n}: ${source.title}`}
      >
        {source.n}
      </button>
      {open && (
        <span
          ref={popoverRef}
          id={popoverId}
          className="citation-popover"
          role="dialog"
          aria-label={`Source ${source.n}`}
          style={
            position
              ? { left: position.left, top: position.top, width: position.width }
              : { visibility: 'hidden', width: POPOVER_WIDTH }
          }
        >
          <span className="citation-popover-header">
            <span className="citation-popover-number">{source.n}</span>
            <strong className="citation-popover-title">{source.title}</strong>
          </span>
          <span className="citation-popover-excerpt">{source.text}</span>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setOpen(false)
              onOpenSource(source.materialId)
            }}
          >
            <Icon name="open" size={14} />
            Open source
          </button>
        </span>
      )}
    </>
  )
}

export default CitationChip
