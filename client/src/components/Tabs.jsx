import { useRef } from 'react'

// Accessible tab list: arrow keys, Home and End move between tabs.
// The panels themselves are rendered by the parent with ids `${idPrefix}-panel-${tab.id}`.
function Tabs({ tabs, value, onChange, label, idPrefix, className = '' }) {
  const listRef = useRef(null)

  function handleKeyDown(event) {
    const index = tabs.findIndex((tab) => tab.id === value)
    const next = {
      ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index - 1 + tabs.length) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    onChange(tabs[next].id)
    listRef.current.querySelectorAll('[role="tab"]')[next]?.focus()
  }

  return (
    <div
      ref={listRef}
      className={`tabs ${className}`}
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${tab.id}`}
          aria-selected={tab.id === value}
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          tabIndex={tab.id === value ? 0 : -1}
          className="tab"
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  )
}

export default Tabs
