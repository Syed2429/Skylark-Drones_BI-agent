import { Fragment, type ReactNode } from 'react';

/**
 * Minimal markdown renderer covering exactly what the agent emits:
 * headings, bullet/numbered lists, bold, inline code and paragraphs.
 *
 * Rendered as React elements rather than injected HTML — the model's output is
 * untrusted text and must never reach dangerouslySetInnerHTML.
 */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];

    if (token.startsWith('**')) {
      out.push(
        <strong key={`${keyPrefix}-b${i}`} className="font-semibold text-white">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('`')) {
      out.push(
        <code
          key={`${keyPrefix}-c${i}`}
          className="rounded bg-ink-700 px-1 py-0.5 font-mono text-[0.85em] text-sky-300"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else {
      out.push(
        <em key={`${keyPrefix}-i${i}`} className="text-slate-300">
          {token.slice(1, -1)}
        </em>
      );
    }

    last = match.index + token.length;
    i += 1;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];

  let listBuffer: { ordered: boolean; items: string[] } | null = null;
  let paraBuffer: string[] = [];

  const flushList = (key: string) => {
    if (!listBuffer) return;
    const { ordered, items } = listBuffer;
    const Tag = ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag
        key={key}
        className={`my-2 space-y-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-slate-500`}
      >
        {items.map((item, i) => (
          <li key={i} className="text-slate-200">
            {renderInline(item, `${key}-${i}`)}
          </li>
        ))}
      </Tag>
    );
    listBuffer = null;
  };

  const flushPara = (key: string) => {
    if (!paraBuffer.length) return;
    blocks.push(
      <p key={key} className="my-2 leading-relaxed text-slate-200">
        {renderInline(paraBuffer.join(' '), key)}
      </p>
    );
    paraBuffer = [];
  };

  lines.forEach((raw, idx) => {
    // Models often bold a whole heading line ("**## Pipeline**"). Unwrap it so
    // the heading is still recognised rather than rendered as literal hashes.
    const line = raw.trimEnd().replace(/^\*\*(#{1,4}\s+.*?)\*\*$/, '$1');
    const key = `l${idx}`;

    if (!line.trim()) {
      flushList(`${key}-ul`);
      flushPara(`${key}-p`);
      return;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushList(`${key}-ul`);
      flushPara(`${key}-p`);
      const level = heading[1].length;
      const cls =
        level <= 2
          ? 'mt-4 mb-1.5 text-[0.95rem] font-semibold tracking-tight text-sky-300 first:mt-0'
          : 'mt-3 mb-1 text-sm font-semibold text-slate-100';
      blocks.push(
        <p key={key} className={cls}>
          {renderInline(heading[2], key)}
        </p>
      );
      return;
    }

    if (/^\s*[-*•]\s+/.test(line)) {
      flushPara(`${key}-p`);
      const item = line.replace(/^\s*[-*•]\s+/, '');
      if (!listBuffer || listBuffer.ordered) {
        flushList(`${key}-ul`);
        listBuffer = { ordered: false, items: [] };
      }
      listBuffer.items.push(item);
      return;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushPara(`${key}-p`);
      if (!listBuffer || !listBuffer.ordered) {
        flushList(`${key}-ul`);
        listBuffer = { ordered: true, items: [] };
      }
      listBuffer.items.push(ordered[1]);
      return;
    }

    if (/^\s*(---|___|\*\*\*)\s*$/.test(line)) {
      flushList(`${key}-ul`);
      flushPara(`${key}-p`);
      blocks.push(<hr key={key} className="my-3 border-ink-700" />);
      return;
    }

    flushList(`${key}-ul`);
    paraBuffer.push(line.trim());
  });

  flushList('end-ul');
  flushPara('end-p');

  return <Fragment>{blocks}</Fragment>;
}
