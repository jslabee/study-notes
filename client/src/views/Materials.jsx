import { useCallback, useEffect, useState } from 'react'
import {
  createCourse,
  deleteMaterial,
  getCourses,
  getMaterials,
  uploadMaterial,
} from '../api.js'

const MAX_SIZE = 5 * 1024 * 1024
const REFRESH_MS = 3000
const STATUS_LABELS = { processing: 'Processing', ready: 'Ready', error: 'Error' }

function Materials({ selectedCourseId, onCourseChange, onOpen }) {
  const [courses, setCourses] = useState([])
  const [materials, setMaterials] = useState([])
  const [error, setError] = useState('')

  const [newCourseOpen, setNewCourseOpen] = useState(false)
  const [newCourseName, setNewCourseName] = useState('')
  const [creatingCourse, setCreatingCourse] = useState(false)

  const [title, setTitle] = useState('')
  const [source, setSource] = useState('text')
  const [text, setText] = useState('')
  const [file, setFile] = useState(null)
  const [fileInputKey, setFileInputKey] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [formError, setFormError] = useState('')

  // Until the user picks a course, the first one is selected
  const courseId = selectedCourseId ?? courses[0]?.id ?? null

  const loadMaterials = useCallback(async () => {
    if (courseId === null) return
    try {
      setMaterials(await getMaterials(courseId))
    } catch (err) {
      setError(err.message)
    }
  }, [courseId])

  useEffect(() => {
    getCourses()
      .then(setCourses)
      .catch((err) => setError(err.message))
  }, [])

  useEffect(() => {
    loadMaterials()
  }, [loadMaterials])

  // Refresh the list while any material is still processing
  const anyProcessing = materials.some((m) => m.status === 'processing')
  useEffect(() => {
    if (!anyProcessing) return
    const timer = setTimeout(loadMaterials, REFRESH_MS)
    return () => clearTimeout(timer)
  }, [anyProcessing, materials, loadMaterials])

  async function handleCreateCourse(event) {
    event.preventDefault()
    setError('')
    setCreatingCourse(true)
    try {
      const course = await createCourse(newCourseName.trim())
      setCourses(await getCourses())
      onCourseChange(course.id)
      setNewCourseName('')
      setNewCourseOpen(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setCreatingCourse(false)
    }
  }

  async function handleUpload(event) {
    event.preventDefault()
    setFormError('')
    if (source === 'file') {
      if (!file) return setFormError('Choose a file to upload.')
      if (file.size > MAX_SIZE) return setFormError('The file is larger than 5 MB.')
    } else if (!text.trim()) {
      return setFormError('Paste some text.')
    }

    setUploading(true)
    try {
      await uploadMaterial({
        courseId,
        title: title.trim(),
        text: source === 'text' ? text : undefined,
        file: source === 'file' ? file : undefined,
      })
      setTitle('')
      setText('')
      setFile(null)
      setFileInputKey((key) => key + 1)
      await loadMaterials()
      setCourses(await getCourses())
    } catch (err) {
      setFormError(err.message)
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete(material) {
    if (!window.confirm(`Delete "${material.title}"? This cannot be undone.`)) return
    setError('')
    try {
      await deleteMaterial(material.id)
      await loadMaterials()
      setCourses(await getCourses())
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <section>
      <h1>Materials</h1>

      {error && <p className="error">{error}</p>}

      <div className="row">
        <label>
          Course{' '}
          <select
            value={courseId ?? ''}
            onChange={(e) => onCourseChange(Number(e.target.value))}
            disabled={courses.length === 0}
          >
            {courses.length === 0 && <option value="">No courses yet</option>}
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name} ({course.materialCount})
              </option>
            ))}
          </select>
        </label>
        {!newCourseOpen && <button onClick={() => setNewCourseOpen(true)}>New course</button>}
      </div>

      {newCourseOpen && (
        <form className="row" onSubmit={handleCreateCourse}>
          <input
            autoFocus
            placeholder="Course name"
            value={newCourseName}
            onChange={(e) => setNewCourseName(e.target.value)}
            disabled={creatingCourse}
          />
          <button type="submit" disabled={creatingCourse || !newCourseName.trim()}>
            {creatingCourse ? 'Creating...' : 'Create'}
          </button>
          <button type="button" onClick={() => setNewCourseOpen(false)} disabled={creatingCourse}>
            Cancel
          </button>
        </form>
      )}

      {courseId !== null && (
        <form className="card" onSubmit={handleUpload}>
          <h2>Add material</h2>
          <label className="field">
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={uploading} />
          </label>
          <div className="row">
            <label>
              <input
                type="radio"
                checked={source === 'text'}
                onChange={() => setSource('text')}
                disabled={uploading}
              />{' '}
              Paste text
            </label>
            <label>
              <input
                type="radio"
                checked={source === 'file'}
                onChange={() => setSource('file')}
                disabled={uploading}
              />{' '}
              Upload file
            </label>
          </div>
          {source === 'text' ? (
            <textarea
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={uploading}
            />
          ) : (
            <label className="field">
              TXT, SRT or VTT, up to 5 MB
              <input
                key={fileInputKey}
                type="file"
                accept=".txt,.srt,.vtt"
                onChange={(e) => setFile(e.target.files[0] ?? null)}
                disabled={uploading}
              />
            </label>
          )}
          {formError && <p className="error">{formError}</p>}
          <button type="submit" disabled={uploading || !title.trim()}>
            {uploading ? 'Uploading...' : 'Add material'}
          </button>
        </form>
      )}

      {courseId !== null &&
        (materials.length === 0 ? (
          <p>No materials in this course yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Type</th>
                <th>Characters</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {materials.map((material) => (
                <tr key={material.id}>
                  <td>
                    <button className="link" onClick={() => onOpen(material.id)}>
                      {material.title}
                    </button>
                  </td>
                  <td>{material.type.toUpperCase()}</td>
                  <td>{material.chars.toLocaleString('en-US')}</td>
                  <td className={`status-${material.status}`}>{STATUS_LABELS[material.status]}</td>
                  <td>
                    <button onClick={() => handleDelete(material)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </section>
  )
}

export default Materials
