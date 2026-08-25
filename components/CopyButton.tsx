'use client';

import { useState } from 'react';

/**
 * Copies an answer to the clipboard.
 *
 * A leadership brief is written to be pasted into an email or a slide, so
 * getting it out of the chat is part of the job, not a nicety.
 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older browsers and non-secure origins have no clipboard API.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button
      onClick={copy}
      className="text-xs text-slate-500 transition-colors hover:text-slate-300"
      aria-label="Copy this answer"
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  );
}
