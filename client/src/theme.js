// Theme (light or dark) applied as data-theme on <html>. On the first visit nothing is stored, so
// the operating system's theme is used and stored; after that the stored choice always applies.
// index.html applies it before the first render with the same key and rules.
export const THEMES = ['light', 'dark']
const STORAGE_KEY = 'study-notes.theme'

const systemTheme = () =>
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

// Storage can be unavailable (private windows, blocked site data); the system theme is used then
export function getTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (THEMES.includes(value)) return value
  } catch {
    // Falls through to the system theme
  }
  return systemTheme()
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // The theme still applies until the page is reloaded
  }
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
}
