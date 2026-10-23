import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { ask, getCourses } from '../api.js'

function Ask({ active, onOpenMaterial }) {
  const [courses, setCourses] = useState([])
  const [courseId, setCourseId] = useState(null)
  const [question, setQuestion] = useState('')
  const [searching, setSearching] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())

  // Courses are reloaded whenever the view is shown, so new courses appear
  useEffect(() => {
    if (!active) return
    getCourses()
      .then(setCourses)
      .catch((err) => setError(err.message))
  }, [active])

  async function handleAsk(event) {
    event.preventDefault()
    setError('')
    setSearching(true)
    try {
      setResult(await ask(question.trim(), courseId))
      setExpanded(new Set())
    } catch (err) {
      setError(err.message)
    } finally {
      setSearching(false)
    }
  }

  function toggleSource(n) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })
  }

  return (
    <section>
      <h1>Ask</h1>

      <form className="card" onSubmit={handleAsk}>
        <label className="field">
          Question
          <textarea
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={searching}
          />
        </label>
        <div className="row">
          <label>
            Course{' '}
            <select
              value={courseId ?? ''}
              onChange={(e) => setCourseId(e.target.value === '' ? null : Number(e.target.value))}
              disabled={searching}
            >
              <option value="">All courses</option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={searching || !question.trim()}>
            Ask
          </button>
          {searching && <span className="status-processing">Searching...</span>}
        </div>
      </form>

      {error && <p className="error">{error}</p>}

      {result && (
        <div className="answer">
          <h2>Answer</h2>
          <div className="notes">
            <ReactMarkdown>{result.answer}</ReactMarkdown>
          </div>

          {result.sources.length > 0 && (
            <>
              <h2>Sources</h2>
              <ol className="sources">
                {result.sources.map((source) => (
                  <li key={source.n} value={source.n}>
                    <button
                      className="link"
                      onClick={() => toggleSource(source.n)}
                      aria-expanded={expanded.has(source.n)}
                    >
                      {source.title}
                    </button>{' '}
                    <button className="link meta" onClick={() => onOpenMaterial(source.materialId)}>
                      Open material
                    </button>
                    {expanded.has(source.n) && <p className="excerpt">{source.text}</p>}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </section>
  )
}

export default Ask
