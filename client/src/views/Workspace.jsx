import { useCallback, useEffect, useRef, useState } from 'react'
import { ask, deleteMaterial, getMaterial, getMaterials } from '../api.js'
import { MIN_WIDTHS, useLayout } from '../layout.js'
import { useLlm } from '../llm.js'
import { useToast } from '../toast.js'
import { useMediaQuery } from '../useMediaQuery.js'
import AddSourceModal from '../components/AddSourceModal.jsx'
import ChatPanel from '../components/ChatPanel.jsx'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import NotesPanel from '../components/NotesPanel.jsx'
import PanelDivider from '../components/PanelDivider.jsx'
import SourcesPanel from '../components/SourcesPanel.jsx'
import Tabs from '../components/Tabs.jsx'
import SourceViewer from './SourceViewer.jsx'

const REFRESH_MS = 3000
// Below this width the three panels are shown as tabs
const NARROW_QUERY = '(max-width: 960px)'
const TABS_ID = 'workspace'

// The course workspace: Sources, Chat and Notes panels, plus the source viewer.
// App renders it with key={course.id}, so all state starts fresh for each course.
function Workspace({ course }) {
  const notify = useToast()
  const { choice } = useLlm()
  const { widths, setWidths } = useLayout()
  const narrow = useMediaQuery(NARROW_QUERY)

  const [materials, setMaterials] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [errorMessages, setErrorMessages] = useState(() => new Map())
  // Unchecked ids are stored instead of checked ones, so every new source starts checked
  const [unchecked, setUnchecked] = useState(() => new Set())
  const [notesId, setNotesId] = useState(null)
  const [viewingId, setViewingId] = useState(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState(null)

  const [messages, setMessages] = useState([])
  const [searching, setSearching] = useState(false)
  const nextMessageId = useRef(1)

  const [collapsed, setCollapsed] = useState({ sources: false, notes: false })
  const [tab, setTab] = useState('chat')
  // Notes across the whole workspace width, with Sources and Chat hidden (wide screens only)
  const [notesExpanded, setNotesExpanded] = useState(false)
  const expanded = notesExpanded && !narrow

  // Esc returns from expanded notes, unless it is closing a dialog
  useEffect(() => {
    if (!expanded) return
    function handleKeyDown(event) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (event.target.closest?.('dialog') || document.querySelector('dialog[open]')) return
      setNotesExpanded(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [expanded])

  const previousStatuses = useRef(null)

  const load = useCallback(async () => {
    try {
      setMaterials(await getMaterials(course.id))
      setLoadError('')
    } catch (err) {
      setLoadError(err.message)
    }
  }, [course.id])

  useEffect(() => {
    load()
  }, [load])

  // Refresh the list while any source is being processed
  const anyProcessing = materials?.some((m) => m.status === 'processing')
  useEffect(() => {
    if (!anyProcessing) return
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [anyProcessing, load])

  // Toasts when processing of a source finishes (not for sources that were already done)
  useEffect(() => {
    if (!materials) return
    const previous = previousStatuses.current
    if (previous) {
      for (const material of materials) {
        if (previous.get(material.id) !== 'processing') continue
        if (material.status === 'ready') notify(`"${material.title}" is ready.`)
        if (material.status === 'error') {
          notify(`"${material.title}" could not be processed.`, { type: 'error' })
        }
      }
    }
    previousStatuses.current = new Map(materials.map((m) => [m.id, m.status]))
  }, [materials, notify])

  // The list has no error messages, so they are loaded once per failed source to show on hover
  const requestedErrors = useRef(new Set())
  useEffect(() => {
    for (const material of materials ?? []) {
      if (material.status !== 'error' || requestedErrors.current.has(material.id)) continue
      requestedErrors.current.add(material.id)
      getMaterial(material.id)
        .then((detail) =>
          setErrorMessages((current) => new Map(current).set(material.id, detail.error))
        )
        .catch(() => requestedErrors.current.delete(material.id))
    }
  }, [materials])

  const isChecked = (id) => !unchecked.has(id)
  const checkedIds = (materials ?? []).filter((m) => isChecked(m.id)).map((m) => m.id)

  function toggleChecked(id) {
    setUnchecked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // The Notes panel shows the clicked source, or the first ready one until a source is clicked
  const notesMaterial =
    materials?.find((m) => m.id === notesId) ??
    materials?.find((m) => m.status === 'ready') ??
    materials?.[0] ??
    null

  function selectForNotes(id) {
    setNotesId(id)
    setCollapsed((current) => ({ ...current, notes: false }))
    if (narrow) setTab('notes')
  }

  function handleAdded({ id, title }) {
    setAdding(false)
    notify(`"${title}" was uploaded and is being processed.`)
    setNotesId(id)
    load()
  }

  async function confirmDelete() {
    const material = deleting
    await deleteMaterial(material.id)
    setDeleting(null)
    notify(`"${material.title}" was deleted.`)
    if (notesId === material.id) setNotesId(null)
    await load()
  }

  async function askQuestion(question) {
    const id = nextMessageId.current
    nextMessageId.current += 2
    setMessages((current) => [...current, { id, role: 'user', text: question }])
    setSearching(true)
    try {
      const { answer, sources, provider, model } = await ask(question, {
        courseId: course.id,
        materialIds: checkedIds,
        ...choice,
      })
      setMessages((current) => [
        ...current,
        { id: id + 1, role: 'assistant', answer, sources, provider, model },
      ])
    } catch (err) {
      setMessages((current) => [
        ...current,
        { id: id + 1, role: 'error', text: err.message, question },
      ])
    } finally {
      setSearching(false)
    }
  }

  // Retrying removes the failed question and its error, then asks again
  function retry(errorMessage) {
    setMessages((current) =>
      current.filter((m) => m.id !== errorMessage.id && m.id !== errorMessage.id - 1)
    )
    askQuestion(errorMessage.question)
  }

  // On narrow screens each panel is a tab panel and only the active one is shown
  function panelProps(id, side) {
    if (narrow) {
      return {
        hidden: tab !== id,
        tabProps: {
          role: 'tabpanel',
          id: `${TABS_ID}-panel-${id}`,
          'aria-labelledby': `${TABS_ID}-tab-${id}`,
        },
      }
    }
    if (expanded) return id === 'notes' ? {} : { hidden: true }
    if (!side) return {}
    return {
      collapsed: collapsed[id],
      onToggle: () => setCollapsed((current) => ({ ...current, [id]: !current[id] })),
    }
  }

  // Wide screens: panels at their saved shares (but at least their minimum width), with
  // dividers between them; a collapsed panel is a narrow rail and cannot be resized
  const track = (id) =>
    collapsed[id]
      ? 'var(--panel-collapsed-width)'
      : `minmax(${MIN_WIDTHS[id]}px, ${widths[id] * 100}fr)`
  let gridStyle
  if (expanded) gridStyle = { gridTemplateColumns: 'minmax(0, 1fr)' }
  else if (!narrow) {
    gridStyle = {
      gridTemplateColumns: [track('sources'), 'var(--space-4)', track('chat'), 'var(--space-4)', track('notes')].join(' '),
    }
  }

  function divider(left, right, label) {
    if (narrow || expanded) return null
    if (collapsed[left] || collapsed[right]) return <div className="panel-gap" aria-hidden="true" />
    return (
      <PanelDivider left={left} right={right} label={label} widths={widths} onResize={setWidths} />
    )
  }

  const readyTitles = (materials ?? [])
    .filter((m) => m.status === 'ready' && isChecked(m.id))
    .map((m) => m.title)

  const layoutClass = narrow ? 'workspace-narrow' : expanded ? 'notes-expanded' : ''

  return (
    <>
      <div className={`workspace ${layoutClass}`} hidden={viewingId !== null}>
        {narrow && (
          <Tabs
            tabs={[
              { id: 'sources', label: 'Sources', count: materials?.length },
              { id: 'chat', label: 'Chat' },
              { id: 'notes', label: 'Notes' },
            ]}
            value={tab}
            onChange={setTab}
            label="Workspace panels"
            idPrefix={TABS_ID}
            className="workspace-tabs"
          />
        )}
        <div className="workspace-panels" style={gridStyle}>
          <SourcesPanel
            materials={materials}
            error={loadError}
            onRetry={load}
            errorMessages={errorMessages}
            isChecked={isChecked}
            checkedCount={checkedIds.length}
            onToggle={toggleChecked}
            onSelectAll={() => setUnchecked(new Set())}
            onClear={() => setUnchecked(new Set((materials ?? []).map((m) => m.id)))}
            selectedId={notesMaterial?.id}
            onSelect={selectForNotes}
            onOpen={setViewingId}
            onDelete={setDeleting}
            onAdd={() => setAdding(true)}
            panelProps={panelProps('sources', 'left')}
          />
          {divider('sources', 'chat', 'Resize Sources and Chat panels')}
          <ChatPanel
            messages={messages}
            searching={searching}
            onSend={askQuestion}
            onRetry={retry}
            onOpenSource={setViewingId}
            onAddSource={() => setAdding(true)}
            selectedCount={checkedIds.length}
            totalCount={materials?.length ?? 0}
            readyTitles={readyTitles}
            panelProps={panelProps('chat')}
          />
          {divider('chat', 'notes', 'Resize Chat and Notes panels')}
          <NotesPanel
            key={notesMaterial?.id ?? 'none'}
            material={notesMaterial}
            onOpenSource={setViewingId}
            expanded={expanded}
            onToggleExpand={narrow ? undefined : () => setNotesExpanded((current) => !current)}
            panelProps={panelProps('notes', 'right')}
          />
        </div>
      </div>

      {viewingId !== null && (
        <SourceViewer key={viewingId} id={viewingId} onBack={() => setViewingId(null)} />
      )}

      {adding && (
        <AddSourceModal
          courseId={course.id}
          onClose={() => setAdding(false)}
          onAdded={handleAdded}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete source?"
          message={`"${deleting.title}" will be deleted together with its notes. This cannot be undone.`}
          confirmLabel="Delete"
          busyLabel="Deleting..."
          onConfirm={confirmDelete}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  )
}

export default Workspace
