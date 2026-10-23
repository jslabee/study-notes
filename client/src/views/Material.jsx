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
  const [notesError, setNotesError] = useState('')
  const [starting, setStarting] = useState(false)

  const loadNotes = useCallback(async () => {
    try {
      setNotes(await getNotes(id))
    } catch (err) {
      setNotesError(err.message)
    }
  }, [id])

  // App renders this view with key={id}, so state starts fresh for each material
  useEffect(() => {
    getMaterial(id)
      .then(setMaterial)
      .catch((err) => setError(err.message))
    loadNotes()
  }, [id, loadNotes])

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
  if (!material) return <p>Loading...</p>

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
      {material.status === 'error' && material.error && (
        <p className="error">{material.error}</p>
      )}

      <div className="card">
        <div className="row">
          <h2>Notes</h2>
          {generating || starting ? (
            <span className="status-processing">Generating notes...</span>
          ) : (
            <button onClick={handleGenerate}>
              {notes?.status === 'ready' ? 'Regenerate' : 'Generate notes'}
            </button>
          )}
        </div>
        {notesError && <p className="error">{notesError}</p>}
        {notes?.status === 'error' && notes.error && <p className="error">{notes.error}</p>}
        {notes?.status === 'ready' && notes.content && (
          <div className="notes">
            <ReactMarkdown>{notes.content}</ReactMarkdown>
          </div>
        )}
        {!notes && !generating && !starting && <p className="meta">No notes yet.</p>}
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
