import { useEffect, useState } from 'react'
import { getHealth } from './api.js'
import Materials from './views/Materials.jsx'
import Material from './views/Material.jsx'
import Ask from './views/Ask.jsx'

function App() {
  const [view, setView] = useState('materials')
  const [serverOnline, setServerOnline] = useState(null)
  const [courseId, setCourseId] = useState(null)
  const [materialId, setMaterialId] = useState(null)

  useEffect(() => {
    getHealth()
      .then((data) => setServerOnline(data.ok === true))
      .catch(() => setServerOnline(false))
  }, [])

  function openMaterial(id) {
    setMaterialId(id)
    setView('material')
  }

  return (
    <>
      <header>
        <strong>Study Notes</strong>
        <nav>
          <button onClick={() => setView('materials')} disabled={view === 'materials'}>
            Materials
          </button>
          <button
            onClick={() => setView('material')}
            disabled={view === 'material' || materialId === null}
          >
            Material
          </button>
          <button onClick={() => setView('ask')} disabled={view === 'ask'}>
            Ask
          </button>
        </nav>
        <span
          className={serverOnline === null ? '' : serverOnline ? 'status-online' : 'status-offline'}
        >
          {serverOnline === null
            ? 'Checking server...'
            : serverOnline
              ? 'Server online'
              : 'Server offline'}
        </span>
      </header>
      <main>
        {view === 'materials' && (
          <Materials
            selectedCourseId={courseId}
            onCourseChange={setCourseId}
            onOpen={openMaterial}
          />
        )}
        {view === 'material' && (
          <Material key={materialId} id={materialId} onBack={() => setView('materials')} />
        )}
        {view === 'ask' && <Ask />}
      </main>
    </>
  )
}

export default App
