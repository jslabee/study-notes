import { useId, useState } from 'react'
import { formatSize } from '../format.js'
import Icon from './Icon.jsx'

export const ACCEPT = '.txt,.srt,.vtt,.pdf'

// Drop a file here or click to choose one; the file input itself stays keyboard accessible
function DropZone({ file, onFile, disabled }) {
  const inputId = useId()
  const [dragging, setDragging] = useState(false)

  function handleDrop(event) {
    event.preventDefault()
    setDragging(false)
    if (disabled) return
    const dropped = event.dataTransfer.files[0]
    if (dropped) onFile(dropped)
  }

  function handleDragOver(event) {
    event.preventDefault()
    if (!disabled) setDragging(true)
  }

  if (file) {
    return (
      <div className="drop-zone-file">
        <Icon name="file" size={20} />
        <span className="drop-zone-file-info">
          <span className="drop-zone-file-name">{file.name}</span>
          <span className="small muted">{formatSize(file.size)}</span>
        </span>
        <button
          type="button"
          className="icon-btn"
          onClick={() => onFile(null)}
          disabled={disabled}
          aria-label={`Remove ${file.name}`}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
    )
  }

  return (
    <div
      className={`drop-zone${dragging ? ' is-dragging' : ''}`}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <input
        id={inputId}
        type="file"
        className="drop-zone-input"
        accept={ACCEPT}
        disabled={disabled}
        onChange={(e) => onFile(e.target.files[0] ?? null)}
      />
      <label htmlFor={inputId} className="drop-zone-label">
        <span className="drop-zone-icon">
          <Icon name="upload" size={22} />
        </span>
        <span>
          <strong>Drop a file here</strong> or <span className="drop-zone-browse">choose a file</span>
        </span>
        <span className="small muted">TXT, SRT, VTT or PDF (max 30 MB)</span>
        <span className="small muted">TXT, SRT and VTT files can be at most 5 MB.</span>
      </label>
    </div>
  )
}

export default DropZone
