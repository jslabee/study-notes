import { useState } from 'react'
import { createCourse } from '../api.js'
import Modal from './Modal.jsx'

function NewCourseModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')
    setSaving(true)
    try {
      const course = await createCourse(name.trim())
      onCreated(course)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <Modal title="New course" onClose={onClose} busy={saving} size="small">
      <form className="stack" onSubmit={handleSubmit}>
        <label className="field">
          Course name
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={saving}
            placeholder="e.g. Cell Biology"
            autoFocus
            required
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !name.trim()}>
            {saving ? 'Creating...' : 'Create course'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export default NewCourseModal
