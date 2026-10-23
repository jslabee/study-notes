// Calls the API and turns { error } responses into thrown errors
async function request(url, options) {
  let res
  try {
    res = await fetch(url, options)
  } catch {
    throw new Error('Could not reach the server.')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error || `Request failed with status ${res.status}.`)
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
