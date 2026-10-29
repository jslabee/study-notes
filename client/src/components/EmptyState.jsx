import Icon from './Icon.jsx'

// Tells the user what to do next when there is nothing to show
function EmptyState({ icon, title, children, action }) {
  return (
    <div className="empty-state">
      {icon && (
        <span className="empty-state-icon">
          <Icon name={icon} size={22} />
        </span>
      )}
      <p className="empty-state-title">{title}</p>
      {children && <p className="empty-state-text">{children}</p>}
      {action}
    </div>
  )
}

export default EmptyState
