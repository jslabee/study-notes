import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { generateNotes, getNotes } from '../api.js'
import { useToast } from '../toast.js'
import EmptyState from './EmptyState.jsx'
import ErrorState from './ErrorState.jsx'
import Icon from './Icon.jsx'
import Panel from './Panel.jsx'
import Skeleton from './Skeleton.jsx'

const REFRESH_MS = 3000

function NotesSkeleton() {
  return (
    <div className="notes-skeleton" aria-hidden="true">
      {['Summary', 'Key points', 'Terms'].map((section, i) => (
        <div key={section} className="stack-tight">
          <Skeleton width={110} height={16} />
          <Skeleton height={12} />
          <Skeleton height={12} />
          <Skeleton width={i === 1 ? '55%' : '75%'} height={12} />
        </div>
      ))}
    </div>
  )
}

// Notes of the material selected in the Sources panel; the Workspace renders it with key={id}
function NotesPanel({ material, onOpenSource, panelProps }) {
  const notify = useToast()
  const materialId = material?.id
  const [notes, setNotes] = useState(undefined)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)

  const load = useCallback(async () => {
    if (materialId === undefined) return
    try {
      setNotes(await getNotes(materialId))
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [materialId])

  useEffect(() => {
    load()
  }, [load])

  // Refresh while the notes are being generated
  const generating = notes?.status === 'processing'
  useEffect(() => {
    if (!generating) return
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [generating, load])

  // Tell the user when generation they are waiting for has finished
  const previousStatus = useRef(undefined)
  const title = material?.title
  useEffect(() => {
    const status = notes?.status
    if (previousStatus.current === 'processing' && status === 'ready') {
      notify(`Notes for "${title}" are ready.`)
    } else if (previousStatus.current === 'processing' && status === 'error') {
      notify(`Notes for "${title}" could not be generated.`, { type: 'error' })
    }
    previousStatus.current = status
  }, [notes, notify, title])

  async function handleGenerate() {
    setError('')
    setStarting(true)
    try {
      await generateNotes(materialId)
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setStarting(false)
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(notes.content)
      notify('Notes copied to the clipboard.')
    } catch {
      notify('The notes could not be copied.', { type: 'error' })
    }
  }

  const ready = notes?.status === 'ready' && notes.content
  const busy = generating || starting

  const headerActions = material && (
    <button
      type="button"
      className="icon-btn"
      onClick={handleCopy}
      disabled={!ready}
      aria-label="Copy notes"
      title="Copy notes"
    >
      <Icon name="copy" size={16} />
    </button>
  )

  let body
  if (!material) {
    body = (
      <EmptyState icon="notes" title="No source selected">
        Add a source, then click its title in the Sources panel to see its notes here.
      </EmptyState>
    )
  } else if (error && notes === undefined) {
    body = (
      <ErrorState
        message={error}
        onRetry={() => {
          setError('')
          load()
        }}
      />
    )
  } else if (notes === undefined) {
    body = <NotesSkeleton />
  } else if (busy) {
    body = (
      <div className="notes-progress" role="status">
        <span className="notes-progress-label">
          <span className="spinner spinner-large" aria-hidden="true" />
          Generating notes...
        </span>
        <span className="progress-bar" aria-hidden="true">
          <span />
        </span>
        <p className="small muted">
          Long sources can take several minutes. You can keep chatting in the meantime.
        </p>
      </div>
    )
  } else if (notes === null) {
    body = (
      <EmptyState
        icon="spark"
        title="No notes yet"
        action={
          <button type="button" className="btn btn-primary" onClick={handleGenerate}>
            <Icon name="spark" size={16} />
            Generate notes
          </button>
        }
      >
        Generate a summary, key points and terms from this source.
      </EmptyState>
    )
  } else if (notes.status === 'error') {
    body = (
      <ErrorState
        message={`Notes could not be generated: ${notes.error || 'unknown error.'}`}
        onRetry={handleGenerate}
      />
    )
  } else {
    body = (
      <article className="markdown notes-content">
        <ReactMarkdown>{notes.content}</ReactMarkdown>
      </article>
    )
  }

  return (
    <Panel
      title="Notes"
      icon="notes"
      side="right"
      className="panel-notes"
      headerActions={headerActions}
      {...panelProps}
    >
      {material && (
        <div className="notes-source">
          <button
            type="button"
            className="notes-source-title"
            onClick={() => onOpenSource(material.id)}
            title="Open source"
          >
            {material.title}
          </button>
          {ready && (
            <button type="button" className="btn btn-small" onClick={handleGenerate} disabled={busy}>
              <Icon name="refresh" size={14} />
              Regenerate
            </button>
          )}
        </div>
      )}
      <div className="panel-body">
        {error && notes !== undefined && <ErrorState message={error} compact />}
        {material?.status === 'processing' && (
          <p className="notes-hint small muted">This source is still being processed.</p>
        )}
        {body}
      </div>
    </Panel>
  )
}

export default NotesPanel
