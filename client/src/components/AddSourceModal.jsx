import { useState } from 'react'
import { uploadMaterial } from '../api.js'
import DropZone from './DropZone.jsx'
import Modal from './Modal.jsx'
import Tabs from './Tabs.jsx'

const MB = 1024 * 1024
// The same limits as the server, checked first so large files are not uploaded for nothing
const LIMITS = { txt: 5 * MB, srt: 5 * MB, vtt: 5 * MB, pdf: 30 * MB }
const LIMIT_ERRORS = {
  text: 'TXT, SRT and VTT files can be at most 5 MB.',
  pdf: 'PDF files can be at most 30 MB.',
}
const TABS = [
  { id: 'file', label: 'Upload file' },
  { id: 'text', label: 'Paste text' },
]

const extension = (name) => name.split('.').pop().toLowerCase()
const titleFromFileName = (name) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()

function validateFile(file) {
  const type = extension(file.name)
  if (!LIMITS[type]) return 'Supported files are TXT, SRT, VTT and PDF.'
  if (file.size > LIMITS[type]) return type === 'pdf' ? LIMIT_ERRORS.pdf : LIMIT_ERRORS.text
  return ''
}

function AddSourceModal({ courseId, onClose, onAdded }) {
  const [tab, setTab] = useState('file')
  const [title, setTitle] = useState('')
  const [titleEdited, setTitleEdited] = useState(false)
  const [file, setFile] = useState(null)
  const [text, setText] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  // A chosen file suggests a title until the user types one
  function handleFile(next) {
    setError(next ? validateFile(next) : '')
    setFile(next)
    if (next && !titleEdited) setTitle(titleFromFileName(next.name))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    if (tab === 'file') {
      if (!file) return setError('Choose a file to upload.')
      const fileError = validateFile(file)
      if (fileError) return setError(fileError)
    } else {
      if (!text.trim()) return setError('Paste some text.')
      if (new Blob([text]).size > 5 * MB) return setError('Pasted text can be at most 5 MB.')
    }

    setUploading(true)
    try {
      const result = await uploadMaterial({
        courseId,
        title: title.trim(),
        text: tab === 'text' ? text : undefined,
        file: tab === 'file' ? file : undefined,
      })
      onAdded({ id: result.id, title: title.trim() })
    } catch (err) {
      setError(err.message)
      setUploading(false)
    }
  }

  const canSubmit = title.trim() && (tab === 'file' ? file : text.trim())

  return (
    <Modal title="Add source" onClose={onClose} busy={uploading}>
      <form className="stack" onSubmit={handleSubmit}>
        <Tabs
          tabs={TABS}
          value={tab}
          onChange={(next) => {
            setTab(next)
            setError('')
          }}
          label="Source type"
          idPrefix="add-source"
          className="tabs-underline"
        />

        <div
          role="tabpanel"
          id={`add-source-panel-${tab}`}
          aria-labelledby={`add-source-tab-${tab}`}
          className="stack"
        >
          {tab === 'file' ? (
            <DropZone file={file} onFile={handleFile} disabled={uploading} />
          ) : (
            <label className="field">
              Text
              <textarea
                className="textarea"
                rows={10}
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={uploading}
                placeholder="Paste lecture notes, a transcript or a chapter..."
              />
              <span className="small muted">Pasted text can be at most 5 MB.</span>
            </label>
          )}

          <label className="field">
            Title
            <input
              className="input"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                setTitleEdited(true)
              }}
              disabled={uploading}
              placeholder="e.g. Lecture 3: Photosynthesis"
              required
            />
          </label>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={uploading}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={uploading || !canSubmit}>
            {uploading && <span className="spinner" aria-hidden="true" />}
            {uploading ? 'Uploading...' : 'Add source'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export default AddSourceModal
