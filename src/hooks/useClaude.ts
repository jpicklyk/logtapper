import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { ChatMessage, ClaudeStreamEvent } from '../bridge/types';
import { claudeAnalyze, claudeGenerateProcessor, setClaudeApiKey } from '../bridge/commands';

const API_KEY_STORAGE_KEY = 'logtapper_claude_api_key';

export interface ClaudeState {
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  apiKey: string;
  setApiKey: (key: string) => Promise<void>;
  sendMessage: (
    text: string,
    sessionId: string,
    processorId?: string,
  ) => Promise<void>;
  generateProcessor: (description: string, sampleLines: string[]) => Promise<string>;
  clearMessages: () => void;
}

export function useClaude(): ClaudeState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKeyState] = useState<string>(
    () => localStorage.getItem(API_KEY_STORAGE_KEY) ?? '',
  );

  // Track the current streaming buffer index to append efficiently.
  const streamingIndexRef = useRef<number>(-1);

  // Subscribe to claude-stream Tauri events.
  useEffect(() => {
    const unlistenPromise = listen<ClaudeStreamEvent>('claude-stream', (event) => {
      const { kind, text, error: errText } = event.payload;

      if (kind === 'text' && text) {
        setMessages((prev) => {
          const idx = streamingIndexRef.current;
          if (idx >= 0 && idx < prev.length) {
            const updated = [...prev];
            updated[idx] = {
              ...updated[idx],
              content: updated[idx].content + text,
            };
            return updated;
          }
          return prev;
        });
      } else if (kind === 'done') {
        setMessages((prev) => {
          const idx = streamingIndexRef.current;
          if (idx >= 0 && idx < prev.length) {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], streaming: false };
            return updated;
          }
          return prev;
        });
        streamingIndexRef.current = -1;
        setStreaming(false);
      } else if (kind === 'error') {
        setError(errText ?? 'Unknown streaming error');
        setStreaming(false);
        streamingIndexRef.current = -1;
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Sync API key to Tauri backend on mount and when it changes.
  useEffect(() => {
    if (apiKey) {
      setClaudeApiKey(apiKey).catch(() => {});
    }
  }, [apiKey]);

  const setApiKey = useCallback(async (key: string) => {
    localStorage.setItem(API_KEY_STORAGE_KEY, key);
    setApiKeyState(key);
    await setClaudeApiKey(key);
  }, []);

  const sendMessage = useCallback(
    async (text: string, sessionId: string, processorId?: string) => {
      if (streaming) return;
      setError(null);

      // Add user message
      const userMsg: ChatMessage = { role: 'user', content: text };
      // Add placeholder assistant message
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: '',
        streaming: true,
      };

      setMessages((prev) => {
        const next = [...prev, userMsg, assistantMsg];
        streamingIndexRef.current = next.length - 1;
        return next;
      });
      setStreaming(true);

      try {
        await claudeAnalyze(sessionId, processorId ?? null, text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStreaming(false);
        streamingIndexRef.current = -1;
        // Remove the empty placeholder
        setMessages((prev) => prev.slice(0, -1));
      }
    },
    [streaming],
  );

  const generateProcessor = useCallback(
    async (description: string, sampleLines: string[]): Promise<string> => {
      if (!apiKey) {
        throw new Error('Claude API key not set');
      }
      return claudeGenerateProcessor(description, sampleLines);
    },
    [apiKey],
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  return {
    messages,
    streaming,
    error,
    apiKey,
    setApiKey,
    sendMessage,
    generateProcessor,
    clearMessages,
  };
}
