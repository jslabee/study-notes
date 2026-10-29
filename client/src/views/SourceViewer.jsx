import { useCallback, useEffect, useRef, useState } from 'react'
import { getMaterial } from '../api.js'
import { formatCount, formatDate, parseTimestamp } from '../format.js'
import ErrorState from '../components/ErrorState.jsx'
import Icon from '../components/Icon.jsx'
import Skeleton from '../components/Skeleton.jsx'
import StatusBadge from '../components/StatusBadge.jsx'
import TypeIcon from '../components/TypeIcon.jsx'

const REFRESH_MS = 3000
const TYPE_LABELS = { text: 'Pasted text', txt: 'TXT', srt: 'SRT', vtt: 'VTT', pdf: 'PDF' }

// Full text of one source in a reading view; the Workspace renders it with key={id}
function SourceViewer({ id, onBack }) {
  const [material, setMaterial] = useState(null)
  const [error, setError] = useState('')
  const backRef = useRef(null)

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

  const added = parseTimestamp(material?.createdAt)

  return (
    <main className="viewer">
      <div className="viewer-bar">
        <button ref={backRef} type="button" className="btn btn-ghost" onClick={onBack}>
          <Icon name="back" size={16} />
          Back to workspace
        </button>
      </div>

      <div className="viewer-scroll">
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
              <div className="viewer-text">{material.content}</div>
            </>
          )}
        </article>
      </div>
    </main>
  )
}

export default SourceViewer
