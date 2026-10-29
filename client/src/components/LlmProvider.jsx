import { useCallback, useEffect, useMemo, useState } from 'react'
import { getLlmModels } from '../api.js'
import { LlmContext, PROVIDERS, effectiveModel } from '../llm.js'

const STORAGE_KEY = 'study-notes.llm-choice'

// The last chosen provider and model are remembered per browser
function readStoredChoice() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY))
    if (PROVIDERS.includes(value?.provider)) {
      return { provider: value.provider, model: typeof value.model === 'string' ? value.model : '' }
    }
  } catch {
    // Unavailable or invalid storage: start from the server defaults
  }
  return null
}

// Loads the providers and models from the server and shares the user's choice with the app
function LlmProvider({ children }) {
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [stored, setStored] = useState(readStoredChoice)

  const load = useCallback(async (refresh) => {
    setRefreshing(true)
    try {
      setInfo(await getLlmModels({ refresh }))
      setError('')
    } catch (err) {
      setError(err.message)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load(false)
  }, [load])

  const setChoice = useCallback((next) => {
    setStored(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // The choice still applies until the page is reloaded
    }
  }, [])

  const value = useMemo(() => {
    const provider = stored?.provider ?? info?.default.provider ?? 'auto'
    const model = effectiveModel(info, { provider, model: stored?.model ?? '' })
    return {
      info,
      error,
      refreshing,
      refresh: () => load(true),
      choice: { provider, model },
      setChoice,
    }
  }, [info, error, refreshing, stored, load, setChoice])

  return <LlmContext.Provider value={value}>{children}</LlmContext.Provider>
}

export default LlmProvider
