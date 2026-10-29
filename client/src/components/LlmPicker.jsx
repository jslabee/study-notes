import { useId } from 'react'
import {
  PROVIDERS,
  PROVIDER_LABELS,
  formatModelSize,
  modelsFor,
  sameModel,
  unavailableReason,
  useLlm,
} from '../llm.js'

// For Auto, the select shows both default models as a hint instead of a choice
function autoHint(info) {
  if (!info) return 'Server defaults'
  const { localModel, openaiModel } = info.default
  const installed = info.local.models.some((m) => localModel && sameModel(m.name, localModel))
  const local = localModel ? `${localModel}${installed ? '' : ' (not installed)'}` : 'no local model'
  const openai = info.allowExternal ? openaiModel || 'no OpenAI model' : 'OpenAI off'
  return `${local} or ${openai}`
}

// Provider (Auto, Local, OpenAI) and model for notes and answers; unavailable providers are
// disabled and say why on hover
function LlmPicker({ disabled = false }) {
  const { info, choice, setChoice } = useLlm()
  const id = useId()
  const models = modelsFor(info, choice.provider)
  const reason = unavailableReason(info, choice.provider)

  let modelOptions
  let modelTitle
  if (choice.provider === 'auto') {
    modelOptions = <option value="">{autoHint(info)}</option>
    modelTitle = 'Auto uses the local model for shorter texts and OpenAI for longer ones.'
  } else if (models.length === 0) {
    modelOptions = <option value="">{info ? 'No models' : 'Loading models...'}</option>
    modelTitle = reason || undefined
  } else {
    const label = (m) => (m.size ? `${m.name} (${formatModelSize(m.size)})` : m.name)
    modelOptions = models.map((m) => (
      <option key={m.name} value={m.name}>
        {label(m)}
      </option>
    ))
    // A long name may be cut off in the select, so the full name is the tooltip
    modelTitle = label(models.find((m) => m.name === choice.model) ?? models[0])
  }

  return (
    <div className="llm-picker">
      <div className="segmented" role="radiogroup" aria-label="Provider">
        {PROVIDERS.map((provider) => {
          const unavailable = unavailableReason(info, provider)
          return (
            <label
              key={provider}
              className="segmented-option"
              title={unavailable || undefined}
            >
              <input
                type="radio"
                name={`${id}-provider`}
                value={provider}
                checked={choice.provider === provider}
                disabled={disabled || Boolean(unavailable)}
                onChange={() => setChoice({ provider, model: '' })}
              />
              <span>{PROVIDER_LABELS[provider]}</span>
            </label>
          )
        })}
      </div>
      <label htmlFor={`${id}-model`} className="visually-hidden">
        Model
      </label>
      <select
        id={`${id}-model`}
        className="select select-small"
        value={choice.provider === 'auto' ? '' : choice.model}
        onChange={(e) => setChoice({ provider: choice.provider, model: e.target.value })}
        disabled={disabled || choice.provider === 'auto' || models.length === 0}
        title={modelTitle}
      >
        {modelOptions}
      </select>
      {reason && choice.provider !== 'auto' && (
        <p className="llm-picker-warning small" role="status">
          {reason}
        </p>
      )}
    </div>
  )
}

export default LlmPicker
