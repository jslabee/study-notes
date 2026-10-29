import { createContext, useContext } from 'react'

// Shares of the workspace width for the three panels; they always add up to 1
export const DEFAULT_WIDTHS = { sources: 0.2, chat: 0.35, notes: 0.45 }
export const MIN_WIDTHS = { sources: 200, chat: 320, notes: 360 }
export const PANEL_IDS = ['sources', 'chat', 'notes']

// { widths, setWidths(widths, { save }), resetLayout }, provided by LayoutProvider
export const LayoutContext = createContext(null)

export function useLayout() {
  return useContext(LayoutContext)
}

// Accepts only three positive shares and scales them to add up to 1
export function normalizeWidths(value) {
  if (!value || !PANEL_IDS.every((id) => Number.isFinite(value[id]) && value[id] > 0)) return null
  const total = PANEL_IDS.reduce((sum, id) => sum + value[id], 0)
  return Object.fromEntries(PANEL_IDS.map((id) => [id, value[id] / total]))
}
