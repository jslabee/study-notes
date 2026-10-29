import { useEffect, useState } from 'react'
import { applyTheme, getTheme, saveTheme } from '../theme.js'
import Icon from './Icon.jsx'

const OPTIONS = [
  { value: 'light', label: 'Light theme', icon: 'sun' },
  { value: 'dark', label: 'Dark theme', icon: 'moon' },
]

// Light or Dark as radio buttons, so arrow keys move between them. The theme is stored also on
// the first visit, when it comes from the operating system, so it stays the same afterwards.
function ThemeControl() {
  const [theme, setTheme] = useState(getTheme)

  useEffect(() => {
    applyTheme(theme)
    saveTheme(theme)
  }, [theme])

  return (
    <div className="segmented theme-control" role="radiogroup" aria-label="Theme">
      {OPTIONS.map(({ value, label, icon }) => (
        <label key={value} className="segmented-option" title={label}>
          <input
            type="radio"
            name="theme"
            value={value}
            checked={theme === value}
            onChange={() => setTheme(value)}
          />
          <span>
            <Icon name={icon} size={14} />
            <span className="visually-hidden">{label}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

export default ThemeControl
