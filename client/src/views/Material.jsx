import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { generateNotes, getMaterial, getNotes } from '../api.js'

const PREVIEW_CHARS = 2000
const REFRESH_MS = 3000
const STATUS_LABELS = { processing: 'Processing', ready: 'Ready', error: 'Error' }

function Material({ id, onBack }) {
  const [material, setMaterial] = useState(null)
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)

  const [notes, setNotes] = useState(null)
  const [notesLoaded, setNotesLoaded] = useState(false)
  const [notesError, setNotesError] = useState('')
  const [starting, setStarting] = useState(false)

  const loadMaterial = useCallback(async () => {
    try {
      setMaterial(await getMaterial(id))
    } catch (err) {
      setError(err.message)
    }
  }, [id])

  const loadNotes = useCallback(async () => {
    try {
      setNotes(await getNotes(id))
    } catch (err) {
      setNotesError(err.message)
    } finally {
      setNotesLoaded(true)
    }
  }, [id])

  // App renders this view with key={id}, so state starts fresh for each material
  useEffect(() => {
    loadMaterial()
    loadNotes()
  }, [loadMaterial, loadNotes])

  // Refresh the material while it is being processed
  const processing = material?.status === 'processing'
  useEffect(() => {
    if (!processing) return
    const timer = setTimeout(loadMaterial, REFRESH_MS)
    return () => clearTimeout(timer)
  }, [processing, material, loadMaterial])

  // Refresh notes while they are being generated
  const generating = notes?.status === 'processing'
  useEffect(() => {
    if (!generating) return
    const timer = setTimeout(loadNotes, REFRESH_MS)
    return () => clearTimeout(timer)
  }, [generating, notes, loadNotes])

  async function handleGenerate() {
    setNotesError('')
    setStarting(true)
    try {
      await generateNotes(id)
      await loadNotes()
    } catch (err) {
      setNotesError(err.message)
    } finally {
      setStarting(false)
    }
  }

  if (error) {
    return (
      <section>
        <button onClick={onBack}>Back</button>
        <p className="error">{error}</p>
      </section>
    )
  }
  if (!material) return <p className="meta">Loading material...</p>

  const truncated = !showAll && material.content.length > PREVIEW_CHARS
  const content = truncated ? material.content.slice(0, PREVIEW_CHARS) : material.content

  return (
    <section>
      <button onClick={onBack}>Back</button>
      <h1>{material.title}</h1>
      <p className="meta">
        {material.type.toUpperCase()} · {material.chars.toLocaleString('en-US')} characters ·{' '}
        <span className={`status-${material.status}`}>{STATUS_LABELS[material.status]}</span>
      </p>
      {processing && (
        <p className="meta">
          This material is being processed. It can be used in questions when it is ready.
        </p>
      )}
      {material.status === 'error' && (
        <p className="error">
          {material.error || 'Processing failed.'} This material is not used in questions.
        </p>
      )}

      <div className="card">
        <div className="row">
          <h2>Notes</h2>
          {generating || starting ? (
            <span className="status-processing">Generating notes...</span>
          ) : (
            <button onClick={handleGenerate} disabled={!notesLoaded}>
              {notes?.status === 'ready' ? 'Regenerate' : 'Generate notes'}
            </button>
          )}
        </div>
        {!notesLoaded && <p className="meta">Loading notes...</p>}
        {generating && (
          <p className="meta">This page refreshes automatically. Long materials can take several minutes.</p>
        )}
        {notesError && <p className="error">{notesError}</p>}
        {notes?.status === 'error' && (
          <p className="error">Notes could not be generated: {notes.error || 'unknown error.'}</p>
        )}
        {notes?.status === 'ready' && notes.content && (
          <div className="notes">
            <ReactMarkdown>{notes.content}</ReactMarkdown>
          </div>
        )}
        {notesLoaded && !notes && !starting && (
          <p className="meta">No notes yet. Use "Generate notes" to create them.</p>
        )}
      </div>

      <h2>Material</h2>
      <div className="content">
        {content}
        {truncated && '…'}
      </div>
      {truncated && <button onClick={() => setShowAll(true)}>Show all</button>}
    </section>
  )
}

export default Material
