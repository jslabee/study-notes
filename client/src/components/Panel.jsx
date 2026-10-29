import { useId } from 'react'
import Icon from './Icon.jsx'

// One workspace panel. Side panels can collapse to a narrow rail with an expand button.
// On narrow screens the workspace shows panels as tabs, so tabProps make it a tab panel.
function Panel({
  title,
  icon,
  side,
  collapsed = false,
  onToggle,
  headerActions,
  tabProps,
  hidden,
  className = '',
  children,
}) {
  const titleId = useId()
  const collapseIcon = side === 'left' ? 'panelLeft' : 'panelRight'

  if (collapsed) {
    return (
      <section
        className={`panel panel-collapsed ${className}`}
        aria-labelledby={titleId}
        hidden={hidden}
      >
        <button
          type="button"
          className="icon-btn"
          onClick={onToggle}
          aria-label={`Expand ${title} panel`}
          aria-expanded="false"
        >
          <Icon name={collapseIcon} />
        </button>
        <h2 id={titleId} className="panel-rail-title">
          <Icon name={icon} size={16} />
          {title}
        </h2>
      </section>
    )
  }

  return (
    <section
      className={`panel ${className}`}
      aria-labelledby={tabProps ? undefined : titleId}
      hidden={hidden}
      {...tabProps}
    >
      <header className="panel-header">
        <h2 id={titleId} className="panel-title">
          {title}
        </h2>
        <div className="panel-actions">
          {headerActions}
          {onToggle && (
            <button
              type="button"
              className="icon-btn"
              onClick={onToggle}
              aria-label={`Collapse ${title} panel`}
              aria-expanded="true"
            >
              <Icon name={collapseIcon} />
            </button>
          )}
        </div>
      </header>
      {children}
    </section>
  )
}

export default Panel
