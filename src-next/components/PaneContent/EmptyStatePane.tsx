import css from './EmptyStatePane.module.css';
import mascotSrc from '../../assets/woodpecker.png';

const BADGE_LABELS = ['React', 'ADB logcat', 'Dumpstate', 'MCP Server'] as const;
const ACCENT_BADGE_CLS = `${css.badge} ${css.badgeAccent}`;

export function EmptyStatePane() {
  return (
    <div className={css.container}>
      <div className={css.grid} />
      <div className={css.glow} />
      <div className={css.glow2} />

      <div className={css.content}>
        <img src={mascotSrc} alt="LogTapper" className={css.mascot} />

        <h1 className={css.title}>
          Log<span className={css.titleAccent}>Tapper</span>
        </h1>

        <p className={css.tagline}>
          Android log analysis, reimagined.<br />
          Dumpstate explorer &amp; live logcat stream viewer.
        </p>

        <div className={css.badges}>
          <span className={ACCENT_BADGE_CLS}>Rust + Tauri</span>
          {BADGE_LABELS.map((label) => (
            <span key={label} className={css.badge}>{label}</span>
          ))}
        </div>
      </div>

      <div className={css.cornerMark}>DESKTOP APP</div>
    </div>
  );
}
