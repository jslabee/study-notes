import Icon from './Icon.jsx'
import { formatCount, formatDate } from '../format.js'

function CourseCard({ course, lastUpdate, onOpen }) {
  return (
    <li>
      <button type="button" className="course-card" onClick={() => onOpen(course)}>
        <span className="course-card-icon">
          <Icon name="notes" size={20} />
        </span>
        <span className="course-card-name">{course.name}</span>
        <span className="course-card-meta">
          <span>{formatCount(course.materialCount, 'source')}</span>
          <span aria-hidden="true">·</span>
          <span>{lastUpdate ? `Updated ${formatDate(lastUpdate)}` : 'No sources yet'}</span>
        </span>
      </button>
    </li>
  )
}

export default CourseCard
