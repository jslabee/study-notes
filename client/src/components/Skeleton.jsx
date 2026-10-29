// Placeholder shapes shown while content loads; hidden from screen readers
function Skeleton({ width = '100%', height = 14, radius, className = '' }) {
  return (
    <span
      className={`skeleton ${className}`}
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  )
}

export default Skeleton
