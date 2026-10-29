import Icon from './Icon.jsx'
import ThemeControl from './ThemeControl.jsx'

const SERVER_LABELS = { null: 'Checking server...', true: 'Server online', false: 'Server offline' }

// App name, the open course as a breadcrumb, the server status, the theme and the settings button
function TopBar({ courseName, onHome, serverOnline, onOpenSettings }) {
  return (
    <header className="topbar">
      {courseName ? (
        <button type="button" className="topbar-brand" onClick={onHome}>
          <span className="topbar-logo">
            <Icon name="book" size={18} />
          </span>
          <span className="topbar-name">Study Notes</span>
        </button>
      ) : (
        <span className="topbar-brand">
          <span className="topbar-logo">
            <Icon name="book" size={18} />
          </span>
          <span className="topbar-name">Study Notes</span>
        </span>
      )}
      {courseName && (
        <>
          <span className="topbar-separator" aria-hidden="true">
            /
          </span>
          <h1 className="topbar-course">{courseName}</h1>
        </>
      )}
      <span className={`server-status server-status-${serverOnline}`}>
        <span className="server-status-dot" aria-hidden="true" />
        <span className="server-status-label">{SERVER_LABELS[serverOnline]}</span>
      </span>
      <ThemeControl />
      <button
        type="button"
        className="icon-btn"
        onClick={onOpenSettings}
        aria-label="Settings"
        title="Settings"
      >
        <Icon name="settings" size={18} />
      </button>
    </header>
  )
}

export default TopBar
