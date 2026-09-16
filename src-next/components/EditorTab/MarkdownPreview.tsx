import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openExternalLinkFromEvent } from '../../bridge/externalLinks';
import styles from './MarkdownPreview.module.css';

const REMARK_PLUGINS = [remarkGfm];

interface MarkdownPreviewProps {
  content: string;
  className?: string;
}

export const MarkdownPreview = React.memo(function MarkdownPreview({
  content,
  className,
}: MarkdownPreviewProps) {
  if (!content) {
    return (
      <div className={`${styles.root} ${className ?? ''}`}>
        <div className={styles.empty}>Nothing to preview</div>
      </div>
    );
  }

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      {/*
        Delegated on the prose container: an `http`/`https`/`mailto` link in the
        previewed document must open in the OS default handler, never navigate
        the webview away from the app. See `bridge/externalLinks.ts`.
      */}
      <div className={styles.prose} onClick={openExternalLinkFromEvent}>
        <Markdown remarkPlugins={REMARK_PLUGINS}>{content}</Markdown>
      </div>
    </div>
  );
});
