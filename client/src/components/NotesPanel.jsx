import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { deleteNotes, generateNotes, getNoteStyles, getNotes } from '../api.js'
import { useLlm } from '../llm.js'
import { useToast } from '../toast.js'
import ConfirmDialog from './ConfirmDialog.jsx'
import EmptyState from './EmptyState.jsx'
import ErrorState from './ErrorState.jsx'
import Icon from './Icon.jsx'
import LlmPicker from './LlmPicker.jsx'
import ModelBadge from './ModelBadge.jsx'
import Panel from './Panel.jsx'
import Skeleton from './Skeleton.jsx'
import Tabs from './Tabs.jsx'

const REFRESH_MS = 3000
const DEFAULT_STYLE = 'study-notes'
const STYLE_STORAGE_KEY = 'study-notes.note-style'

// The styles do not change while the app runs, so they are loaded once for all materials
let stylesRequest = null
function loadStyles() {
  stylesRequest ??= getNoteStyles().catch((err) => {
    stylesRequest = null
    throw err
  })
  return stylesRequest
}

// The last chosen style is remembered per browser
function readStoredStyle() {
  try {
    return localStorage.getItem(STYLE_STORAGE_KEY) || DEFAULT_STYLE
  } catch {
    return DEFAULT_STYLE
  }
}

function storeStyle(style) {
  try {
    localStorage.setItem(STYLE_STORAGE_KEY, style)
  } catch {
    // The choice still applies until the page is reloaded
  }
}

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

function NotesProgress() {
  return (
    <div className="notes-progress" role="status">
      <span className="notes-progress-label">
        <span className="spinner spinner-large" aria-hidden="true" />
        Generating notes...
      </span>
      <span className="progress-bar" aria-hidden="true">
        <span />
      </span>
      <p className="small muted">
        Long sources can take several minutes. You can view other styles and keep chatting in
        the meantime.
      </p>
    </div>
  )
}

// Status shown in a style's tab next to its name
function TabStatus({ status }) {
  if (status === 'processing') {
    return (
      <span className="spinner" role="img" aria-label="Generating" title="Generating" />
    )
  }
  if (status === 'error') {
    return (
      <span className="notes-tab-error" role="img" aria-label="Failed" title="Failed">
        <Icon name="alert" size={14} />
      </span>
    )
  }
  return null
}

// Notes of the material selected in the Sources panel, one tab per generated style;
// the Workspace renders it with key={id}
function NotesPanel({ material, onOpenSource, panelProps }) {
  const notify = useToast()
  const { choice } = useLlm()
  const materialId = material?.id
  const [styles, setStyles] = useState(null)
  const [notesList, setNotesList] = useState(undefined)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const [selectedStyle, setSelectedStyle] = useState(readStoredStyle)
  const [activeStyle, setActiveStyle] = useState(null)
  const [deleting, setDeleting] = useState(null)

  useEffect(() => {
    loadStyles()
      .then(setStyles)
      .catch((err) => setError(err.message))
  }, [])

  const load = useCallback(async () => {
    if (materialId === undefined) return
    try {
      setNotesList(await getNotes(materialId))
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [materialId])

  useEffect(() => {
    load()
  }, [load])

  // Refresh while any style is being generated
  const anyProcessing = notesList?.some((n) => n.status === 'processing')
  useEffect(() => {
    if (!anyProcessing) return
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [anyProcessing, load])

  const styleName = useCallback(
    (id) => styles?.find((s) => s.id === id)?.name ?? id,
    [styles]
  )

  // Tell the user when generation they are waiting for has finished, per style
  const previousStatuses = useRef(null)
  const title = material?.title
  useEffect(() => {
    if (!notesList) return
    const previous = previousStatuses.current
    if (previous) {
      for (const notes of notesList) {
        if (previous.get(notes.style) !== 'processing') continue
        const label = `${styleName(notes.style)} for "${title}"`
        if (notes.status === 'ready') notify(`${label} is ready.`)
        if (notes.status === 'error') notify(`${label} could not be generated.`, { type: 'error' })
      }
    }
    previousStatuses.current = new Map(notesList.map((n) => [n.style, n.status]))
  }, [notesList, notify, title, styleName])

  // A remembered style that no longer exists falls back to the default
  const generateStyle = styles?.some((s) => s.id === selectedStyle) ? selectedStyle : DEFAULT_STYLE
  const selectedInfo = styles?.find((s) => s.id === generateStyle)

  // The open tab: the one the user picked, else the chosen style, else the first generated
  const generated = notesList ?? []
  const shownStyle =
    [activeStyle, generateStyle].find((id) => generated.some((n) => n.style === id)) ??
    generated[0]?.style ??
    null
  const shown = generated.find((n) => n.style === shownStyle) ?? null

  const existing = generated.find((n) => n.style === generateStyle)
  const generateBusy = starting || existing?.status === 'processing'

  function selectStyle(id) {
    setSelectedStyle(id)
    storeStyle(id)
    // Show that style's notes if it already has some
    if (generated.some((n) => n.style === id)) setActiveStyle(id)
  }

  async function handleGenerate(style = generateStyle) {
    setError('')
    setStarting(true)
    try {
      await generateNotes(materialId, { style, ...choice })
      setActiveStyle(style)
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setStarting(false)
    }
  }

  async function handleCopy(notes) {
    try {
      await navigator.clipboard.writeText(notes.content)
      notify('Notes copied to the clipboard.')
    } catch {
      notify('The notes could not be copied.', { type: 'error' })
    }
  }

  async function confirmDelete() {
    const style = deleting
    await deleteNotes(materialId, style)
    setDeleting(null)
    notify(`${styleName(style)} for "${title}" was deleted.`)
    await load()
  }

  const tabsId = `notes-${materialId}`

  let body
  if (!material) {
    body = (
      <EmptyState icon="notes" title="No source selected">
        Add a source, then click its title in the Sources panel to see its notes here.
      </EmptyState>
    )
  } else if (error && notesList === undefined) {
    body = (
      <ErrorState
        message={error}
        onRetry={() => {
          setError('')
          load()
        }}
      />
    )
  } else if (notesList === undefined) {
    body = <NotesSkeleton />
  } else if (!shown) {
    body = (
      <EmptyState icon="spark" title="No notes yet">
        Choose a style above and click Generate to create notes from this source.
      </EmptyState>
    )
  } else {
    let content
    if (shown.status === 'processing') {
      content = <NotesProgress />
    } else if (shown.status === 'error') {
      content = (
        <ErrorState
          message={`Notes could not be generated: ${shown.error || 'unknown error.'}`}
          onRetry={() => handleGenerate(shown.style)}
        />
      )
    } else {
      content = (
        <article className="markdown notes-content">
          <ReactMarkdown>{shown.content}</ReactMarkdown>
        </article>
      )
    }

    body = (
      <>
        <Tabs
          tabs={generated.map((notes) => ({
            id: notes.style,
            label: (
              <>
                {styleName(notes.style)}
                <TabStatus status={notes.status} />
              </>
            ),
          }))}
          value={shown.style}
          onChange={setActiveStyle}
          label="Generated note styles"
          idPrefix={tabsId}
          className="tabs-underline notes-tabs"
        />
        <div
          role="tabpanel"
          id={`${tabsId}-panel-${shown.style}`}
          aria-labelledby={`${tabsId}-tab-${shown.style}`}
          className="notes-tabpanel"
        >
          <div className="notes-tab-toolbar">
            {shown.status === 'ready' && <ModelBadge value={shown.model} />}
            <span className="notes-tab-actions">
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() => handleCopy(shown)}
                disabled={shown.status !== 'ready' || !shown.content}
              >
                <Icon name="copy" size={14} />
                Copy
              </button>
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() => setDeleting(shown.style)}
              >
                <Icon name="trash" size={14} />
                Delete
              </button>
            </span>
          </div>
          {content}
        </div>
      </>
    )
  }

  return (
    <Panel title="Notes" icon="notes" side="right" className="panel-notes" {...panelProps}>
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
        </div>
      )}
      {material && notesList !== undefined && (
        <div className="notes-generate-bar">
          <label className="notes-style-field">
            <span className="visually-hidden">Note style</span>
            <select
              className="select"
              value={generateStyle}
              onChange={(e) => selectStyle(e.target.value)}
              disabled={!styles}
            >
              {(styles ?? [{ id: generateStyle, name: 'Loading styles...' }]).map((style) => (
                <option key={style.id} value={style.id}>
                  {style.description ? `${style.name} – ${style.description}` : style.name}
                </option>
              ))}
            </select>
          </label>
          {selectedInfo && <p className="notes-style-description small muted">{selectedInfo.description}</p>}
          <div className="notes-generate">
            <LlmPicker />
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={() => handleGenerate()}
              disabled={!styles || generateBusy}
              title={generateBusy ? 'This style is being generated.' : undefined}
            >
              <Icon name={existing ? 'refresh' : 'spark'} size={14} />
              {existing ? 'Regenerate' : 'Generate'}
            </button>
          </div>
        </div>
      )}
      <div className="panel-body">
        {error && notesList !== undefined && <ErrorState message={error} compact />}
        {material?.status === 'processing' && (
          <p className="notes-hint small muted">This source is still being processed.</p>
        )}
        {body}
      </div>

      {deleting && (
        <ConfirmDialog
          title="Delete notes?"
          message={`${styleName(deleting)} for "${title}" will be deleted. This cannot be undone.`}
          confirmLabel="Delete"
          busyLabel="Deleting..."
          onConfirm={confirmDelete}
          onClose={() => setDeleting(null)}
        />
      )}
    </Panel>
  )
}

export default NotesPanel
