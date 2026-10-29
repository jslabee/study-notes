import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getMaterial } from '../api.js'
import { formatCount, formatDate, parseTimestamp } from '../format.js'
import ErrorState from '../components/ErrorState.jsx'
import Icon from '../components/Icon.jsx'
import Skeleton from '../components/Skeleton.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import TypeIcon from '../components/TypeIcon.jsx'

const REFRESH_MS = 3000
const TYPE_LABELS = { text: 'Pasted text', txt: 'TXT', srt: 'SRT', vtt: 'VTT', pdf: 'PDF' }

// The passage when its offsets fit the text, otherwise null (the viewer then opens at the top)
function validPassage(passage, content) {
  if (!passage || typeof content !== 'string') return null
  const { start, end } = passage
  return start >= 0 && end > start && end <= content.length ? passage : null
}

// Full text of one source in a reading view; the Workspace renders it with key={id}. With a
// passage ({ start, end, page } from a citation) the cited text is highlighted and scrolled into view.
function SourceViewer({ id, passage = null, onBack }) {
  const [material, setMaterial] = useState(null)
  const [error, setError] = useState('')
  const backRef = useRef(null)
  const scrollRef = useRef(null)
  const passageRef = useRef(null)
  const scrolledRef = useRef(false)

  const load = useCallback(async () => {
    try {
      setMaterial(await getMaterial(id))
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  // The back button gets focus when the viewer opens, so keyboard users start there
  useEffect(() => {
    backRef.current?.focus()
  }, [])

  function retry() {
    setError('')
    load()
  }

  const processing = material?.status === 'processing'
  useEffect(() => {
    if (!processing) return
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [processing, load])

  const cited = validPassage(passage, material?.content)

  // Scroll once, when the text first appears, so a later refresh does not move the reader
  useLayoutEffect(() => {
    const mark = passageRef.current
    const scroll = scrollRef.current
    if (!mark || !scroll || scrolledRef.current) return
    scrolledRef.current = true
    const offset = mark.getBoundingClientRect().top - scroll.getBoundingClientRect().top
    // A little of the text before the passage stays visible above it
    scroll.scrollTop += offset - scroll.clientHeight / 4
  }, [cited])

  const added = parseTimestamp(material?.createdAt)

  return (
    <main className="viewer">
      <div className="viewer-bar">
        <button ref={backRef} type="button" className="btn btn-ghost" onClick={onBack}>
          <Icon name="back" size={16} />
          Back to workspace
        </button>
        {/* In the bar, so the page stays visible while the text is scrolled to the passage */}
        {cited?.page && <span className="viewer-page-number">Cited passage on p. {cited.page}</span>}
      </div>

      <div className="viewer-scroll" ref={scrollRef}>
        <article className="viewer-page" aria-busy={!material && !error}>
          {error && !material && <ErrorState message={error} onRetry={retry} />}

          {!material && !error && (
            <div className="stack" aria-hidden="true">
              <Skeleton width="60%" height={30} />
              <Skeleton width="40%" height={14} />
              {Array.from({ length: 9 }, (_, i) => (
                <Skeleton key={i} width={i % 4 === 3 ? '70%' : '100%'} height={14} />
              ))}
            </div>
          )}

          {material && (
            <>
              <header className="viewer-header">
                <h1>{material.title}</h1>
                <p className="viewer-meta">
                  <TypeIcon type={material.type} />
                  <span>{TYPE_LABELS[material.type] ?? material.type}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatCount(material.chars, 'character')}</span>
                  {added && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>Added {formatDate(added)}</span>
                    </>
                  )}
                  <StatusBadge status={material.status} error={material.error} />
                </p>
                {processing && (
                  <p className="viewer-notice">
                    This source is being processed. It can be used in questions when it is ready.
                  </p>
                )}
                {material.status === 'error' && (
                  <p className="viewer-notice viewer-notice-error">
                    {material.error || 'Processing failed.'} This source is not used in questions.
                  </p>
                )}
              </header>
              <div className="viewer-text">
                {cited ? (
                  <>
                    {material.content.slice(0, cited.start)}
                    <mark ref={passageRef} className="viewer-passage" aria-label="Cited passage">
                      {material.content.slice(cited.start, cited.end)}
                    </mark>
                    {material.content.slice(cited.end)}
                  </>
                ) : (
                  material.content
                )}
              </div>
            </>
          )}
        </article>
      </div>
    </main>
  )
}

export default SourceViewer
