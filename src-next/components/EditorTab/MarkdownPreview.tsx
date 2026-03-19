import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
      <div className={styles.prose}>
        <Markdown remarkPlugins={REMARK_PLUGINS}>{content}</Markdown>
      </div>
    </div>
  );
});
