import { useEffect, useState } from 'react'
import { getHealth } from './api.js'
import Materials from './views/Materials.jsx'
import Material from './views/Material.jsx'
import Ask from './views/Ask.jsx'

const views = {
  materials: { label: 'Materials', component: Materials },
  material: { label: 'Material', component: Material },
  ask: { label: 'Ask', component: Ask },
}

function App() {
  const [view, setView] = useState('materials')
  const [serverOnline, setServerOnline] = useState(null)

  useEffect(() => {
    getHealth()
      .then((data) => setServerOnline(data.ok === true))
      .catch(() => setServerOnline(false))
  }, [])

  const View = views[view].component

  return (
    <>
      <p>
        {serverOnline === null
          ? 'Checking server...'
          : serverOnline
            ? 'Server online'
            : 'Server offline'}
      </p>
      <nav>
        {Object.entries(views).map(([key, { label }]) => (
          <button key={key} onClick={() => setView(key)} disabled={view === key}>
            {label}
          </button>
        ))}
      </nav>
      <main>
        <View />
      </main>
    </>
  )
}

export default App
