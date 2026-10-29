import Icon from './Icon.jsx'

const TYPES = {
  text: { icon: 'text', label: 'Pasted text' },
  txt: { icon: 'file', label: 'TXT file' },
  srt: { icon: 'subtitles', label: 'SRT subtitles' },
  vtt: { icon: 'subtitles', label: 'VTT subtitles' },
  pdf: { icon: 'pdf', label: 'PDF file' },
}

function TypeIcon({ type }) {
  const { icon, label } = TYPES[type] ?? TYPES.txt
  return (
    <span className={`type-icon type-icon-${type}`} title={label}>
      <Icon name={icon} size={16} />
      <span className="visually-hidden">{label}</span>
    </span>
  )
}

export default TypeIcon
