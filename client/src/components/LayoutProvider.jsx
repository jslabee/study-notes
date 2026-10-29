import { useCallback, useMemo, useState } from 'react'
import { DEFAULT_WIDTHS, LayoutContext, normalizeWidths } from '../layout.js'

const STORAGE_KEY = 'study-notes.panel-widths'

// The panel widths are remembered per browser
function readStoredWidths() {
  try {
    return normalizeWidths(JSON.parse(localStorage.getItem(STORAGE_KEY))) ?? DEFAULT_WIDTHS
  } catch {
    return DEFAULT_WIDTHS
  }
}

// Shares the workspace panel widths, so the settings dialog can reset them
function LayoutProvider({ children }) {
  const [widths, setWidthsState] = useState(readStoredWidths)

  // While dragging the widths change without saving; the final widths are saved once
  const setWidths = useCallback((next, { save = true } = {}) => {
    const normalized = normalizeWidths(next)
    if (!normalized) return
    setWidthsState(normalized)
    if (!save) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
    } catch {
      // The widths still apply until the page is reloaded
    }
  }, [])

  const resetLayout = useCallback(() => {
    setWidthsState(DEFAULT_WIDTHS)
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Nothing was stored
    }
  }, [])

  const value = useMemo(() => ({ widths, setWidths, resetLayout }), [widths, setWidths, resetLayout])
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>
}

export default LayoutProvider
