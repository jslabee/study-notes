// SQLite CURRENT_TIMESTAMP is UTC in the form "YYYY-MM-DD HH:MM:SS"
export function parseTimestamp(value) {
  if (!value) return null
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatCount(n, singular, plural = `${singular}s`) {
  return `${n.toLocaleString('en-US')} ${n === 1 ? singular : plural}`
}
