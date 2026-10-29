import { useCallback, useEffect, useState } from 'react'
import { getCourses, getMaterials } from '../api.js'
import { parseTimestamp } from '../format.js'
import { useToast } from '../toast.js'
import CourseCard from '../components/CourseCard.jsx'
import ErrorState from '../components/ErrorState.jsx'
import Icon from '../components/Icon.jsx'
import NewCourseModal from '../components/NewCourseModal.jsx'
import Skeleton from '../components/Skeleton.jsx'

const SKELETON_CARDS = 3

// The API has no course timestamp, so a course's last update is its newest material
function lastUpdates(materials) {
  const latest = new Map()
  for (const material of materials) {
    const date = parseTimestamp(material.createdAt)
    if (date && !(latest.get(material.courseId) > date)) latest.set(material.courseId, date)
  }
  return latest
}

function Home({ onOpenCourse }) {
  const notify = useToast()
  const [courses, setCourses] = useState(null)
  const [updates, setUpdates] = useState(new Map())
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try {
      const [courseList, materials] = await Promise.all([
        getCourses(),
        // The dates are extra information; the cards are shown without them if this fails
        getMaterials().catch(() => []),
      ])
      setCourses(courseList)
      setUpdates(lastUpdates(materials))
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function retry() {
    setError('')
    load()
  }

  function handleCreated(course) {
    setCreating(false)
    notify(`Course "${course.name}" was created.`)
    onOpenCourse(course)
  }

  // Most recently updated courses first; courses without sources follow by name
  const sorted = courses
    ? [...courses].sort(
        (a, b) =>
          (updates.get(b.id) ?? 0) - (updates.get(a.id) ?? 0) || a.name.localeCompare(b.name)
      )
    : []

  return (
    <main className="home">
      <div className="home-inner">
        <div className="home-heading">
          <h1>Your courses</h1>
          <p className="muted">
            Each course collects its sources, the notes generated from them and a chat about them.
          </p>
        </div>

        {error && <ErrorState message={error} onRetry={retry} />}

        {!error && (
          <ul className="course-grid" aria-busy={courses === null}>
            <li>
              <button
                type="button"
                className="course-card course-card-new"
                onClick={() => setCreating(true)}
              >
                <span className="course-card-new-icon">
                  <Icon name="plus" size={26} />
                </span>
                <span className="course-card-name">New course</span>
              </button>
            </li>
            {courses === null &&
              Array.from({ length: SKELETON_CARDS }, (_, i) => (
                <li key={i} className="course-card course-card-skeleton" aria-hidden="true">
                  <Skeleton width={40} height={40} radius="var(--radius-md)" />
                  <Skeleton width="70%" height={18} />
                  <Skeleton width="50%" height={12} />
                </li>
              ))}
            {sorted.map((course) => (
              <CourseCard
                key={course.id}
                course={course}
                lastUpdate={updates.get(course.id)}
                onOpen={onOpenCourse}
              />
            ))}
          </ul>
        )}

        {courses?.length === 0 && (
          <p className="muted home-hint">
            No courses yet. Create your first course, then add sources to it.
          </p>
        )}
      </div>

      {creating && <NewCourseModal onClose={() => setCreating(false)} onCreated={handleCreated} />}
    </main>
  )
}

export default Home
