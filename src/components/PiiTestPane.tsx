import { useState } from 'react';
import type { AnonymizerTestResult, PiiReplacement } from '../bridge/types';
import { testAnonymizer } from '../bridge/commands';

// Category → color mapping for highlighting
const CATEGORY_COLORS: Record<string, string> = {
  EMAIL: 'var(--pii-color-email, #f59e0b)',
  IPv4: 'var(--pii-color-ipv4, #3b82f6)',
  IPv6: 'var(--pii-color-ipv6, #6366f1)',
  MAC: 'var(--pii-color-mac, #8b5cf6)',
  PHONE: 'var(--pii-color-phone, #ec4899)',
  IMEI: 'var(--pii-color-imei, #ef4444)',
  SERIAL: 'var(--pii-color-serial, #10b981)',
  AID: 'var(--pii-color-aid, #14b8a6)',
  PII: 'var(--pii-color-custom, #f97316)',
};

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.PII;
}

interface AnnotatedTextProps {
  text: string;
  replacements: PiiReplacement[];
}

function AnnotatedText({ text, replacements }: AnnotatedTextProps) {
  if (replacements.length === 0) {
    return <span className="pii-test-annotated-text">{text}</span>;
  }

  // Build segments: non-replaced text + replaced spans
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  const segments: JSX.Element[] = [];
  let cursor = 0;

  // Use a TextEncoder to work with byte offsets
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(text);

  for (const rep of sorted) {
    if (rep.start > cursor) {
      const plain = decoder.decode(bytes.slice(cursor, rep.start));
      segments.push(<span key={`plain-${cursor}`}>{plain}</span>);
    }
    const tokenText = decoder.decode(bytes.slice(rep.start, rep.end));
    const color = getCategoryColor(rep.category);
    segments.push(
      <span
        key={`token-${rep.start}`}
        className="pii-test-token"
        style={{ backgroundColor: color + '33', border: `1px solid ${color}`, color }}
        title={`${rep.category}: was "${rep.original}"`}
      >
        {tokenText}
      </span>
    );
    cursor = rep.end;
  }
  if (cursor < bytes.length) {
    const plain = decoder.decode(bytes.slice(cursor));
    segments.push(<span key="plain-end">{plain}</span>);
  }

  return <div className="pii-test-annotated-text">{segments}</div>;
}

export default function PiiTestPane() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<AnonymizerTestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleTest() {
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await testAnonymizer(input);
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="pii-test-pane">
      <div className="pii-test-hint">
        Paste any text below to see what the current PII configuration would anonymize.
      </div>
      <textarea
        className="pii-test-input"
        placeholder="Paste text here, e.g.: User user@example.com logged in from 192.168.1.42"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={5}
        spellCheck={false}
      />
      <div className="pii-test-actions">
        <button
          className="btn-primary"
          onClick={handleTest}
          disabled={!input.trim() || loading}
        >
          {loading ? 'Testing\u2026' : 'Anonymize'}
        </button>
        {result && (
          <button
            className="btn-secondary"
            onClick={() => { setResult(null); setInput(''); }}
          >
            Clear
          </button>
        )}
      </div>

      {error && <div className="pii-test-error">{error}</div>}

      {result && (
        <div className="pii-test-result">
          <div className="pii-test-result-label">Result:</div>
          <div className="pii-test-result-box">
            <AnnotatedText text={result.anonymized} replacements={result.replacements} />
          </div>

          {result.replacements.length === 0 ? (
            <div className="pii-test-no-matches">No PII detected with current configuration.</div>
          ) : (
            <table className="pii-test-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Original</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {result.replacements.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <code
                        className="pii-test-token-code"
                        style={{ color: getCategoryColor(r.category) }}
                      >
                        {r.token}
                      </code>
                    </td>
                    <td className="pii-test-original">{r.original}</td>
                    <td>
                      <span
                        className="proc-tag"
                        style={{ backgroundColor: getCategoryColor(r.category) + '22' }}
                      >
                        {r.category}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
