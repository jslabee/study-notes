import { createContext, useContext } from 'react'

export const PROVIDERS = ['auto', 'local', 'openai']
export const PROVIDER_LABELS = { auto: 'Auto', local: 'Local', openai: 'OpenAI' }

// { info, error, refreshing, refresh, choice, setChoice }, provided by LlmProvider
export const LlmContext = createContext(null)

export function useLlm() {
  return useContext(LlmContext)
}

// Ollama treats "name" and "name:latest" as the same model
const withoutLatest = (name) => name.replace(/:latest$/, '')
export const sameModel = (a, b) => withoutLatest(a) === withoutLatest(b)

function localReason(info) {
  if (!info.local.reachable) return 'Ollama is not reachable.'
  if (info.local.models.length === 0) return 'No local chat models are installed in Ollama.'
  return ''
}

function openaiReason(info) {
  if (!info.allowExternal) return 'The external provider is turned off on the server (ALLOW_EXTERNAL).'
  if (!info.openai.configured) return 'No OpenAI API key is set on the server.'
  if (info.openai.models.length === 0) return 'No OpenAI models are configured on the server.'
  return ''
}

// Why a provider cannot be used right now, or '' when it can (or while the list is loading)
export function unavailableReason(info, provider) {
  if (!info) return ''
  const local = localReason(info)
  const openai = openaiReason(info)
  if (provider === 'local') return local
  if (provider === 'openai') return openai
  return local && openai ? `No provider is available. ${local} ${openai}` : ''
}

export function modelsFor(info, provider) {
  if (!info) return []
  if (provider === 'local') return info.local.models
  if (provider === 'openai') return info.openai.models.map((name) => ({ name }))
  return []
}

// The model to send: the remembered one while it is still offered, else the provider default,
// else the first offered model; Auto sends no model, so the server uses both defaults
export function effectiveModel(info, { provider, model }) {
  if (provider === 'auto') return ''
  if (!info) return model
  const names = modelsFor(info, provider).map((m) => m.name)
  const remembered = model && names.find((name) => sameModel(name, model))
  if (remembered) return remembered
  const fallback = provider === 'local' ? info.default.localModel : info.default.openaiModel
  return names.find((name) => fallback && sameModel(name, fallback)) ?? names[0] ?? ''
}

export function formatModelSize(bytes) {
  if (!bytes) return ''
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}
