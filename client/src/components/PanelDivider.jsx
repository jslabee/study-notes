import { useRef } from 'react'
import { MIN_WIDTHS } from '../layout.js'

const KEY_STEP = 16
const KEY_STEP_LARGE = 64

// Moves the boundary between two neighboring panels by dx pixels, keeping both at least at
// their minimum width; the pair keeps its share of the workspace and the third panel is unchanged
function resize(widths, left, right, leftPx, rightPx, dx) {
  const pairPx = leftPx + rightPx
  const newLeft = Math.min(Math.max(leftPx + dx, MIN_WIDTHS[left]), pairPx - MIN_WIDTHS[right])
  const pairShare = widths[left] + widths[right]
  return {
    ...widths,
    [left]: (pairShare * newLeft) / pairPx,
    [right]: (pairShare * (pairPx - newLeft)) / pairPx,
  }
}

// The panels are the divider's neighbors in the grid
function neighborWidths(divider) {
  return [
    divider.previousElementSibling.getBoundingClientRect().width,
    divider.nextElementSibling.getBoundingClientRect().width,
  ]
}

// A draggable boundary between two panels; arrow keys move it when it has focus
// (Shift for larger steps, Home and End to the limits)
function PanelDivider({ left, right, label, widths, onResize }) {
  const drag = useRef(null)

  function handlePointerDown(event) {
    if (event.button !== 0) return
    event.preventDefault()
    const [leftPx, rightPx] = neighborWidths(event.currentTarget)
    drag.current = { startX: event.clientX, widths, leftPx, rightPx }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus()
    document.body.classList.add('resizing')
  }

  function dragged(event) {
    const { startX, widths: start, leftPx, rightPx } = drag.current
    return resize(start, left, right, leftPx, rightPx, event.clientX - startX)
  }

  function handlePointerMove(event) {
    if (drag.current) onResize(dragged(event), { save: false })
  }

  function handlePointerUp(event) {
    if (!drag.current) return
    onResize(dragged(event))
    drag.current = null
    document.body.classList.remove('resizing')
  }

  function handleKeyDown(event) {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    const dx = {
      ArrowLeft: -step,
      ArrowRight: step,
      Home: -Infinity,
      End: Infinity,
    }[event.key]
    if (dx === undefined) return
    event.preventDefault()
    const [leftPx, rightPx] = neighborWidths(event.currentTarget)
    onResize(resize(widths, left, right, leftPx, rightPx, dx))
  }

  const share = Math.round((widths[left] / (widths[left] + widths[right])) * 100)

  return (
    <div
      className="panel-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={share}
      tabIndex={0}
      title="Drag to resize, or use the arrow keys"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
    />
  )
}

export default PanelDivider
