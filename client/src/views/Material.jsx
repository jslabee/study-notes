import { useEffect, useState } from 'react'
import { getMaterial } from '../api.js'

const PREVIEW_CHARS = 2000
const STATUS_LABELS = { processing: 'Processing', ready: 'Ready', error: 'Error' }

function Material({ id, onBack }) {
  const [material, setMaterial] = useState(null)
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)

  // App renders this view with key={id}, so state starts fresh for each material
  useEffect(() => {
    getMaterial(id)
      .then(setMaterial)
      .catch((err) => setError(err.message))
  }, [id])

  if (error) {
    return (
      <section>
        <button onClick={onBack}>Back to materials</button>
        <p className="error">{error}</p>
      </section>
    )
  }
  if (!material) return <p>Loading...</p>

  const truncated = !showAll && material.content.length > PREVIEW_CHARS
  const content = truncated ? material.content.slice(0, PREVIEW_CHARS) : material.content

  return (
    <section>
      <button onClick={onBack}>Back to materials</button>
      <h1>{material.title}</h1>
      <p className="meta">
        {material.type.toUpperCase()} · {material.chars.toLocaleString('en-US')} characters ·{' '}
        <span className={`status-${material.status}`}>{STATUS_LABELS[material.status]}</span>
      </p>
      {material.status === 'error' && material.error && (
        <p className="error">{material.error}</p>
      )}
      <div className="content">
        {content}
        {truncated && '…'}
      </div>
      {truncated && <button onClick={() => setShowAll(true)}>Show all</button>}
    </section>
  )
}

export default Material
