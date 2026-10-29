import ReactMarkdown from 'react-markdown'
import CitationChip from './CitationChip.jsx'

const CITATION_PREFIX = '#cite-'
// [2] or [1, 3], but not the text of a Markdown link such as [2](url)
const CITATION = /\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g

// Turns citations into Markdown links to known sources, which are then rendered as chips
function linkCitations(answer, sourceCount) {
  return answer.replace(CITATION, (match, list) => {
    const numbers = list.split(',').map((n) => Number(n.trim()))
    if (!numbers.every((n) => n >= 1 && n <= sourceCount)) return match
    return numbers.map((n) => `[${n}](${CITATION_PREFIX}${n})`).join('')
  })
}

function AnswerText({ answer, sources, onOpenSource }) {
  const components = {
    a({ href, children }) {
      if (href?.startsWith(CITATION_PREFIX)) {
        const source = sources[Number(href.slice(CITATION_PREFIX.length)) - 1]
        return <CitationChip source={source} onOpenSource={onOpenSource} />
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      )
    },
  }

  return (
    <div className="markdown">
      <ReactMarkdown components={components}>{linkCitations(answer, sources.length)}</ReactMarkdown>
    </div>
  )
}

export default AnswerText
