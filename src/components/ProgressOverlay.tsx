interface Props {
  message: string;
  progress?: number; // 0-1
}

export default function ProgressOverlay({ message, progress }: Props) {
  return (
    <div className="progress-overlay">
      <div className="progress-card">
        <div className="progress-message">{message}</div>
        {progress != null && (
          <div className="progress-bar-wrap">
            <div
              className="progress-bar-fill"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}
        {progress != null && (
          <div className="progress-pct">{Math.round(progress * 100)}%</div>
        )}
      </div>
    </div>
  );
}
