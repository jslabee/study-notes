import { useEffect, useState } from 'react'
import { getHealth } from './api.js'
import LlmProvider from './components/LlmProvider.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import ToastProvider from './components/ToastProvider.jsx'
import TopBar from './components/TopBar.jsx'
import Home from './views/Home.jsx'
import Workspace from './views/Workspace.jsx'

// Two screens: the course grid and a course workspace (no router library)
function App() {
  const [course, setCourse] = useState(null)
  const [serverOnline, setServerOnline] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    getHealth()
      .then((data) => setServerOnline(data.ok === true))
      .catch(() => setServerOnline(false))
  }, [])

  return (
    <ToastProvider>
      <LlmProvider>
        <div className="app">
          <TopBar
            courseName={course?.name}
            onHome={() => setCourse(null)}
            serverOnline={serverOnline}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          {course ? <Workspace key={course.id} course={course} /> : <Home onOpenCourse={setCourse} />}
        </div>
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      </LlmProvider>
    </ToastProvider>
  )
}

export default App
