import Icon from './Icon.jsx'
import StatusBadge from './StatusBadge.jsx'
import TypeIcon from './TypeIcon.jsx'

// One source in the Sources panel: checkbox for the chat, title selects it for the Notes panel
function SourceItem({ material, error, checked, selected, onToggle, onSelect, onOpen, onDelete }) {
  const checkboxId = `source-check-${material.id}`
  return (
    <li className={`source-item${selected ? ' is-selected' : ''}`}>
      <input
        id={checkboxId}
        type="checkbox"
        className="checkbox"
        checked={checked}
        onChange={() => onToggle(material.id)}
      />
      <label htmlFor={checkboxId} className="visually-hidden">
        Use "{material.title}" in chat
      </label>
      <TypeIcon type={material.type} />
      <div className="source-item-main">
        <button
          type="button"
          className="source-item-title"
          onClick={() => onSelect(material.id)}
          aria-current={selected ? 'true' : undefined}
          title={`Show notes for "${material.title}"`}
        >
          {material.title}
        </button>
        <StatusBadge status={material.status} error={error} />
      </div>
      <div className="source-item-actions">
        <button
          type="button"
          className="icon-btn"
          onClick={() => onOpen(material.id)}
          aria-label={`Open "${material.title}"`}
          title="Open source"
        >
          <Icon name="open" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-danger"
          onClick={() => onDelete(material)}
          aria-label={`Delete "${material.title}"`}
          title="Delete source"
        >
          <Icon name="trash" size={16} />
        </button>
      </div>
    </li>
  )
}

export default SourceItem
