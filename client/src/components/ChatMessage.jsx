import AnswerText from './AnswerText.jsx'
import ErrorState from './ErrorState.jsx'
import { formatCount } from '../format.js'

function ChatMessage({ message, onOpenSource, onRetry }) {
  if (message.role === 'user') {
    return (
      <li className="message message-user">
        <span className="visually-hidden">You asked:</span>
        <div className="bubble bubble-user">{message.text}</div>
      </li>
    )
  }

  if (message.role === 'error') {
    return (
      <li className="message message-assistant">
        <ErrorState message={message.text} onRetry={onRetry} compact />
      </li>
    )
  }

  return (
    <li className="message message-assistant">
      <span className="visually-hidden">Answer:</span>
      <div className="bubble bubble-assistant">
        <AnswerText
          answer={message.answer}
          sources={message.sources}
          onOpenSource={onOpenSource}
        />
        <p className="bubble-footer">
          {message.sources.length === 0
            ? 'No matching excerpts were found. Only sources with status Ready are searched.'
            : `Based on ${formatCount(message.sources.length, 'excerpt')}`}
        </p>
      </div>
    </li>
  )
}

export default ChatMessage
