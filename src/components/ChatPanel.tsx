import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClaudeState } from '../hooks/useClaude';

interface Props {
  claude: ClaudeState;
  sessionId: string | null;
  processorId?: string | null;
}

export default function ChatPanel({ claude, sessionId, processorId }: Props) {
  const [input, setInput] = useState('');
  const [showKeySettings, setShowKeySettings] = useState(!claude.apiKey);
  const [keyDraft, setKeyDraft] = useState(claude.apiKey);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on new messages.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [claude.messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !sessionId || claude.streaming) return;
    setInput('');
    await claude.sendMessage(text, sessionId, processorId ?? undefined);
  }, [input, sessionId, processorId, claude]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleSaveKey = useCallback(async () => {
    await claude.setApiKey(keyDraft);
    setShowKeySettings(false);
  }, [keyDraft, claude]);

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-header">
        <span className="chat-title">Claude Analysis</span>
        <div className="chat-header-actions">
          {claude.messages.length > 0 && (
            <button
              className="btn-icon-sm"
              title="Clear conversation"
              onClick={claude.clearMessages}
            >
              ✕
            </button>
          )}
          <button
            className={`btn-icon-sm${showKeySettings ? ' active' : ''}`}
            title="API key settings"
            onClick={() => setShowKeySettings((v) => !v)}
          >
            ⚙
          </button>
        </div>
      </div>

      {/* API key settings */}
      {showKeySettings && (
        <div className="chat-key-settings">
          <label className="chat-key-label">Anthropic API Key</label>
          <input
            type="password"
            className="chat-key-input"
            placeholder="sk-ant-..."
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSaveKey()}
          />
          <button className="btn-primary chat-key-save" onClick={handleSaveKey}>
            Save
          </button>
          <p className="chat-key-hint">
            Your key is stored locally and never sent anywhere except the
            Anthropic API.
          </p>
        </div>
      )}

      {/* Context banner */}
      {sessionId && (
        <div className="chat-context-banner">
          {processorId ? (
            <span>
              Context: session + <strong>{processorId}</strong> results
            </span>
          ) : (
            <span>Context: current log session</span>
          )}
        </div>
      )}

      {!sessionId && (
        <div className="chat-no-session">
          Load a log file first to enable analysis.
        </div>
      )}

      {/* Message list */}
      <div className="chat-messages">
        {claude.messages.length === 0 && sessionId && !showKeySettings && (
          <div className="chat-empty">
            <p>Ask Claude about your log data.</p>
            <p className="chat-empty-hint">
              Examples: "What errors appear most often?" or "Why might WiFi be
              disconnecting?"
            </p>
          </div>
        )}

        {claude.messages.map((msg, i) => (
          <div
            key={i}
            className={`chat-message chat-message-${msg.role}${msg.streaming ? ' chat-message-streaming' : ''}`}
          >
            <div className="chat-message-role">
              {msg.role === 'user' ? 'You' : 'Claude'}
            </div>
            <div className="chat-message-content">
              {msg.content || (msg.streaming ? <span className="chat-cursor">▊</span> : '')}
              {msg.streaming && msg.content && <span className="chat-cursor">▊</span>}
            </div>
          </div>
        ))}

        {claude.error && (
          <div className="chat-error">
            <strong>Error:</strong> {claude.error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="chat-input-area">
        <textarea
          className="chat-input"
          placeholder={
            !claude.apiKey
              ? 'Set your API key above first…'
              : !sessionId
              ? 'Load a log file first…'
              : 'Ask about this log… (Enter to send, Shift+Enter for newline)'
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!sessionId || !claude.apiKey || claude.streaming}
          rows={3}
        />
        <button
          className="btn-primary chat-send-btn"
          onClick={handleSend}
          disabled={!sessionId || !claude.apiKey || claude.streaming || !input.trim()}
        >
          {claude.streaming ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
