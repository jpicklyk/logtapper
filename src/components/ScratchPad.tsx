import { useState } from 'react';

export default function ScratchPad() {
  const [text, setText] = useState('');

  return (
    <textarea
      className="scratch-pad"
      value={text}
      onChange={(e) => setText(e.target.value)}
      placeholder="Scratch notes…"
      spellCheck={false}
      autoComplete="off"
    />
  );
}
