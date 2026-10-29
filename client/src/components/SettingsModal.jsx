import { useLayout } from '../layout.js'
import { PROVIDER_LABELS, formatModelSize, useLlm } from '../llm.js'
import { useToast } from '../toast.js'
import ErrorState from './ErrorState.jsx'
import Icon from './Icon.jsx'
import Modal from './Modal.jsx'

// Read-only view of the server's provider settings, with a button to reload the model lists,
// and the workspace layout reset
function SettingsModal({ onClose }) {
  const { info, error, refreshing, refresh } = useLlm()
  const { resetLayout } = useLayout()
  const notify = useToast()

  function handleResetLayout() {
    resetLayout()
    notify('The panel widths were reset.')
  }

  const footer = (
    <button type="button" className="btn" onClick={refresh} disabled={refreshing}>
      {refreshing ? (
        <span className="spinner" aria-hidden="true" />
      ) : (
        <Icon name="refresh" size={16} />
      )}
      Refresh models
    </button>
  )

  let body
  if (!info) {
    body = error ? <ErrorState message={error} onRetry={refresh} /> : <p className="muted">Loading...</p>
  } else {
    const { local, openai } = info
    body = (
      <div className="stack">
        {error && <ErrorState message={error} compact />}
        <dl className="settings-list">
          <div>
            <dt>Default provider</dt>
            <dd>{PROVIDER_LABELS[info.default.provider]}</dd>
          </div>
          <div>
            <dt>Default local model</dt>
            <dd>{info.default.localModel || 'Not set'}</dd>
          </div>
          <div>
            <dt>Default OpenAI model</dt>
            <dd>{info.default.openaiModel || 'Not set'}</dd>
          </div>
          <div>
            <dt>
              <label className="settings-check">
                <input type="checkbox" className="checkbox" checked={info.allowExternal} disabled readOnly />
                Allow external provider
              </label>
            </dt>
            <dd className="small muted">Set on the server (ALLOW_EXTERNAL).</dd>
          </div>
          <div>
            <dt>Ollama</dt>
            <dd>
              <span className={`badge ${local.reachable ? 'badge-ready' : 'badge-error'}`}>
                {local.reachable ? 'Reachable' : 'Not reachable'}
              </span>
            </dd>
          </div>
          <div>
            <dt>OpenAI API key</dt>
            <dd>
              <span className={`badge ${openai.configured ? 'badge-ready' : 'badge-error'}`}>
                {openai.configured ? 'Configured' : 'Missing'}
              </span>
            </dd>
          </div>
        </dl>

        <section className="stack-tight">
          <h3 className="settings-heading">Local chat models</h3>
          {local.models.length === 0 ? (
            <p className="small muted">
              {local.reachable ? 'No chat models are installed in Ollama.' : 'Start Ollama to see its models.'}
            </p>
          ) : (
            <ul className="settings-models">
              {local.models.map((m) => (
                <li key={m.name}>
                  <span>{m.name}</span>
                  <span className="muted">{formatModelSize(m.size)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="stack-tight">
          <h3 className="settings-heading">OpenAI models</h3>
          <ul className="settings-models">
            {openai.models.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </section>
      </div>
    )
  }

  return (
    <Modal title="Settings" onClose={onClose} footer={footer}>
      <div className="stack">
        {body}
        <section className="settings-layout">
          <div>
            <h3 className="settings-heading">Layout</h3>
            <p className="small muted">Panel widths are remembered in this browser.</p>
          </div>
          <button type="button" className="btn btn-small" onClick={handleResetLayout}>
            Reset layout
          </button>
        </section>
      </div>
    </Modal>
  )
}

export default SettingsModal
