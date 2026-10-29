import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import ChatMessage from './ChatMessage.jsx'
import EmptyState from './EmptyState.jsx'
import Icon from './Icon.jsx'
import Panel from './Panel.jsx'

const MAX_INPUT_HEIGHT = 180

// Three starter questions built from the titles of the selected sources that are ready
function starterQuestions(titles) {
  if (titles.length === 0) return []
  const [first, second] = titles
  return [
    `Summarize the main ideas of "${first}".`,
    `What are the most important terms in "${second ?? first}", and what do they mean?`,
    second
      ? `How are "${first}" and "${second}" related?`
      : `What questions could appear in an exam about "${first}"?`,
  ]
}

function ChatPanel({
  messages,
  searching,
  onSend,
  onRetry,
  onOpenSource,
  onAddSource,
  selectedCount,
  totalCount,
  readyTitles,
  panelProps,
}) {
  const [draft, setDraft] = useState('')
  const listRef = useRef(null)
  const inputRef = useRef(null)

  // Keep the newest message in view
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages, searching])

  // The input grows with its content up to a maximum height
  useLayoutEffect(() => {
    const input = inputRef.current
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_HEIGHT)}px`
  }, [draft])

  const canAsk = selectedCount > 0 && !searching

  function send(question) {
    const text = question.trim()
    if (!text || !canAsk) return
    onSend(text)
    setDraft('')
  }

  function handleKeyDown(event) {
    // Enter sends, Shift+Enter adds a new line; Enter while composing text (IME) does nothing
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send(draft)
    }
  }

  const starters = starterQuestions(readyTitles)
  let note
  if (totalCount === 0) note = 'Add a source to start asking questions.'
  else if (selectedCount === 0) note = 'Select at least one source to ask a question.'
  else note = `Answers use ${selectedCount} of ${totalCount} sources.`

  return (
    <Panel title="Chat" icon="chat" className="panel-chat" {...panelProps}>
      <div className="chat-scroll" ref={listRef}>
        {messages.length === 0 && !searching ? (
          <div className="chat-empty">
            {totalCount === 0 ? (
              <EmptyState
                icon="upload"
                title="Add your first source"
                action={
                  <button type="button" className="btn btn-primary" onClick={onAddSource}>
                    <Icon name="plus" size={16} />
                    Add source
                  </button>
                }
              >
                Questions are answered only from the sources in this course.
              </EmptyState>
            ) : (
              <>
                <EmptyState icon="chat" title="Ask about your sources">
                  Answers cite the excerpts they are based on. Click a number to see the excerpt.
                </EmptyState>
                {starters.length > 0 ? (
                  <ul className="starter-list" aria-label="Suggested questions">
                    {starters.map((question) => (
                      <li key={question}>
                        <button
                          type="button"
                          className="starter"
                          onClick={() => send(question)}
                          disabled={!canAsk}
                        >
                          {question}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="small muted chat-empty-hint">
                    Suggested questions appear when a selected source is ready.
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
          <ol className="message-list" aria-label="Conversation">
            {messages.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                onOpenSource={onOpenSource}
                onRetry={() => onRetry(message)}
              />
            ))}
            {searching && (
              <li className="message message-assistant">
                <div className="bubble bubble-assistant bubble-searching">
                  <span className="typing" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  Searching...
                </div>
              </li>
            )}
          </ol>
        )}
      </div>

      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault()
          send(draft)
        }}
      >
        <div className="chat-input-wrap">
          <label htmlFor="chat-input" className="visually-hidden">
            Ask a question about the selected sources
          </label>
          <textarea
            id="chat-input"
            ref={inputRef}
            className="chat-input"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              totalCount === 0
                ? 'Add a source first'
                : selectedCount > 0
                  ? 'Ask a question...'
                  : 'Select a source first'
            }
            disabled={totalCount === 0}
            aria-describedby="chat-note"
          />
          <button
            type="submit"
            className="chat-send"
            disabled={!canAsk || !draft.trim()}
            aria-label="Send question"
          >
            <Icon name="send" size={18} />
          </button>
        </div>
        <p id="chat-note" className="chat-note" aria-live="polite">
          {searching ? 'Searching...' : note}
          <span className="chat-shortcut"> Enter to send, Shift+Enter for a new line.</span>
        </p>
      </form>
    </Panel>
  )
}

export default ChatPanel
