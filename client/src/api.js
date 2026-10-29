// Calls the API and turns { error } responses into thrown errors
async function request(url, options) {
  let res
  try {
    res = await fetch(url, options)
  } catch {
    throw new Error('Could not reach the server.')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed with status ${res.status}.`)
    err.status = res.status
    throw err
  }
  return data
}

function postJson(url, body) {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function getHealth() {
  return request('/api/health')
}

export function getCourses() {
  return request('/api/courses')
}

export function createCourse(name) {
  return postJson('/api/courses', { name })
}

// Without a courseId, the materials of all courses are returned
export function getMaterials(courseId) {
  if (courseId === undefined) return request('/api/materials')
  return request(`/api/materials?courseId=${encodeURIComponent(courseId)}`)
}

export function getMaterial(id) {
  return request(`/api/materials/${id}`)
}

// fields: { courseId, title } plus either text or file
export function uploadMaterial({ courseId, title, text, file }) {
  const form = new FormData()
  form.append('courseId', courseId)
  form.append('title', title)
  if (file) form.append('file', file)
  else form.append('text', text)
  return request('/api/materials', { method: 'POST', body: form })
}

export function deleteMaterial(id) {
  return request(`/api/materials/${id}`, { method: 'DELETE' })
}

export function getNoteStyles() {
  return request('/api/note-styles')
}

// Notes of all styles generated for the material
export function getNotes(materialId) {
  return request(`/api/materials/${materialId}/notes`)
}

// Provider (auto | local | openai) and model; an empty model means the server default
function llmChoice({ provider, model } = {}) {
  const body = {}
  if (provider) body.provider = provider
  if (model) body.model = model
  return body
}

export function generateNotes(materialId, { style, ...choice } = {}) {
  return postJson(`/api/materials/${materialId}/notes`, { style, ...llmChoice(choice) })
}

export function deleteNotes(materialId, style) {
  return request(`/api/materials/${materialId}/notes/${encodeURIComponent(style)}`, {
    method: 'DELETE',
  })
}

// courseId null means all courses; materialIds limits the search to those materials
export function ask(question, { courseId = null, materialIds, provider, model } = {}) {
  const body = { question, ...llmChoice({ provider, model }) }
  if (courseId !== null) body.courseId = courseId
  if (materialIds) body.materialIds = materialIds
  return postJson('/api/ask', body)
}

// Default provider, whether OpenAI is allowed and the models of both providers
export function getLlmModels({ refresh = false } = {}) {
  return request(refresh ? '/api/llm/models?refresh=1' : '/api/llm/models')
}
