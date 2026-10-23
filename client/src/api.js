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

export function getMaterials(courseId) {
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

// Returns null when the material has no notes yet
export async function getNotes(materialId) {
  try {
    return await request(`/api/materials/${materialId}/notes`)
  } catch (err) {
    if (err.status === 404) return null
    throw err
  }
}

export function generateNotes(materialId) {
  return request(`/api/materials/${materialId}/notes`, { method: 'POST' })
}

// courseId null means all courses
export function ask(question, courseId) {
  return postJson('/api/ask', courseId === null ? { question } : { question, courseId })
}
