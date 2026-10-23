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
  const [returnView, setReturnView] = useState('materials')

  useEffect(() => {
    getHealth()
      .then((data) => setServerOnline(data.ok === true))
      .catch(() => setServerOnline(false))
  }, [])

  // The Material view's back button returns to the view the material was opened from
  function openMaterial(id, from) {
    setMaterialId(id)
    setReturnView(from)
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
            onOpen={(id) => openMaterial(id, 'materials')}
          />
        )}
        {view === 'material' && (
          <Material key={materialId} id={materialId} onBack={() => setView(returnView)} />
        )}
        {/* Ask stays mounted so the answer is kept while a source material is open */}
        <div hidden={view !== 'ask'}>
          <Ask active={view === 'ask'} onOpenMaterial={(id) => openMaterial(id, 'ask')} />
        </div>
      </main>
    </>
  )
}

export default App
