import { useEffect, useState } from 'react'
import { getHealth } from './api.js'
import ToastProvider from './components/ToastProvider.jsx'
import TopBar from './components/TopBar.jsx'
import Home from './views/Home.jsx'
import Workspace from './views/Workspace.jsx'

// Two screens: the course grid and a course workspace (no router library)
function App() {
  const [course, setCourse] = useState(null)
  const [serverOnline, setServerOnline] = useState(null)

  useEffect(() => {
    getHealth()
      .then((data) => setServerOnline(data.ok === true))
      .catch(() => setServerOnline(false))
  }, [])

  return (
    <ToastProvider>
      <div className="app">
        <TopBar courseName={course?.name} onHome={() => setCourse(null)} serverOnline={serverOnline} />
        {course ? <Workspace key={course.id} course={course} /> : <Home onOpenCourse={setCourse} />}
      </div>
    </ToastProvider>
  )
}

export default App
