import EmptyState from './EmptyState.jsx'
import ErrorState from './ErrorState.jsx'
import Icon from './Icon.jsx'
import Panel from './Panel.jsx'
import Skeleton from './Skeleton.jsx'
import SourceItem from './SourceItem.jsx'

const SKELETON_ROWS = 4

function SourcesPanel({
  materials,
  error,
  onRetry,
  errorMessages,
  isChecked,
  checkedCount,
  onToggle,
  onSelectAll,
  onClear,
  selectedId,
  onSelect,
  onOpen,
  onDelete,
  onAdd,
  panelProps,
}) {
  const loading = materials === null && !error

  return (
    <Panel title="Sources" icon="file" side="left" className="panel-sources" {...panelProps}>
      <div className="panel-toolbar">
        <button type="button" className="btn btn-block" onClick={onAdd}>
          <Icon name="plus" size={16} />
          Add source
        </button>
      </div>

      <div className="panel-body">
        {error && materials === null && <ErrorState message={error} onRetry={onRetry} />}

        {loading && (
          <ul className="source-list" aria-label="Loading sources" aria-busy="true">
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <li key={i} className="source-item source-item-skeleton" aria-hidden="true">
                <Skeleton width={18} height={18} />
                <Skeleton width={28} height={28} radius="var(--radius-sm)" />
                <span className="source-item-main">
                  <Skeleton width={`${80 - i * 10}%`} height={14} />
                  <Skeleton width={56} height={14} radius="var(--radius-pill)" />
                </span>
              </li>
            ))}
          </ul>
        )}

        {materials?.length === 0 && (
          <EmptyState
            icon="upload"
            title="Add your first source"
            action={
              <button type="button" className="btn btn-primary" onClick={onAdd}>
                <Icon name="plus" size={16} />
                Add source
              </button>
            }
          >
            Upload a TXT, SRT, VTT or PDF file, or paste text. Notes and answers are based only on
            your sources.
          </EmptyState>
        )}

        {materials?.length > 0 && (
          <>
            <div className="source-selection">
              <span className="small muted" aria-live="polite">
                {checkedCount} of {materials.length} selected
              </span>
              <span className="source-selection-actions">
                <button
                  type="button"
                  className="link-btn"
                  onClick={onSelectAll}
                  disabled={checkedCount === materials.length}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="link-btn"
                  onClick={onClear}
                  disabled={checkedCount === 0}
                >
                  Clear
                </button>
              </span>
            </div>
            <ul className="source-list" aria-label="Sources">
              {materials.map((material) => (
                <SourceItem
                  key={material.id}
                  material={material}
                  error={errorMessages.get(material.id)}
                  checked={isChecked(material.id)}
                  selected={material.id === selectedId}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  onOpen={onOpen}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </Panel>
  )
}

export default SourcesPanel
