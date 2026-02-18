import { useEffect, useState } from 'react';

interface Props {
  sessionId: string;
  processorId: string;
  getVars: (sessionId: string, processorId: string) => Promise<Record<string, unknown>>;
  /** Poll interval in ms; 0 = no polling */
  pollMs?: number;
}

function renderValue(val: unknown): React.ReactNode {
  if (val === null || val === undefined) return <span className="var-null">—</span>;
  if (typeof val === 'boolean') return <span className="var-bool">{val ? 'true' : 'false'}</span>;
  if (typeof val === 'number') return <span className="var-number">{val.toLocaleString()}</span>;
  if (typeof val === 'string') return <span className="var-string">"{val}"</span>;
  if (Array.isArray(val)) {
    if (val.length === 0) return <span className="var-empty">[]</span>;
    // Check if it's an array of objects (table-like)
    if (typeof val[0] === 'object' && val[0] !== null) {
      const keys = Object.keys(val[0] as object);
      return (
        <table className="var-table">
          <thead>
            <tr>{keys.map((k) => <th key={k}>{k}</th>)}</tr>
          </thead>
          <tbody>
            {(val as Record<string, unknown>[]).slice(0, 100).map((row, i) => (
              <tr key={i}>
                {keys.map((k) => <td key={k}>{String(row[k] ?? '')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    return <span className="var-array">[{val.length} items]</span>;
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>);
    if (entries.length === 0) return <span className="var-empty">{'{}'}</span>;
    return (
      <table className="var-table">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td className="var-key">{k}</td>
              <td>{renderValue(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return <span>{String(val)}</span>;
}

export default function VarInspector({ sessionId, processorId, getVars, pollMs = 0 }: Props) {
  const [vars, setVars] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId || !processorId) return;

    let cancelled = false;

    async function fetch() {
      try {
        const v = await getVars(sessionId, processorId);
        if (!cancelled) setVars(v);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }

    fetch();

    if (pollMs > 0) {
      const id = setInterval(() => { if (!cancelled) fetch(); }, pollMs);
      return () => {
        cancelled = true;
        clearInterval(id);
      };
    }
    return () => { cancelled = true; };
  }, [sessionId, processorId, getVars, pollMs]);

  if (error) return <div className="var-error">{error}</div>;
  if (!vars) return <div className="var-empty">No variable data</div>;

  const entries = Object.entries(vars);
  if (entries.length === 0) return <div className="var-empty">No variables declared</div>;

  return (
    <div className="var-inspector">
      {entries.map(([name, value]) => (
        <div key={name} className="var-row">
          <div className="var-name">{name}</div>
          <div className="var-value">{renderValue(value)}</div>
        </div>
      ))}
    </div>
  );
}
