'use client';

import { useEffect, useRef, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { ToolTrace, type TraceEntry } from '@/components/ToolTrace';
import { CopyButton } from '@/components/CopyButton';
import { Charts } from '@/components/Charts';
import type { ChartSpec } from '@/lib/agent/charts';

const SUGGESTED = [
  'How are we doing?',
  "How's our pipeline for the energy sector this quarter?",
  'Prepare a leadership update',
  'What have we won but not yet invoiced?',
  'Which projects are stuck or running late?',
  'Who owes us money right now?',
  'Mining vs Renewables — how do they compare?',
  'How complete is our data?',
];

interface ResponseMeta {
  source: 'monday' | 'mock';
  isMock: boolean;
  fetchedAt: string;
  deals: number;
  workOrders: number;
  rounds: number;
  model: string;
  schemaWarnings: string[];
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  charts?: ChartSpec[];
  trace?: TraceEntry[];
  meta?: ResponseMeta;
  error?: boolean;
  hint?: string;
}

const GREETING = `Ask me anything about your pipeline, projects, invoicing or collections.

I read your Monday.com boards fresh every time, so the numbers are always current. Under any answer you can open **How I worked this out** to see exactly where each figure came from.`;

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: GREETING },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<ResponseMeta | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  function startOver() {
    setMessages([{ role: 'assistant', content: GREETING }]);
    setInput('');
    inputRef.current?.focus();
  }

  async function send(text: string) {
    const question = text.trim();
    if (!question || loading) return;

    // Only clean Q&A goes back as history — never the tool payloads.
    const history = messages
      .filter((m) => !m.error && m.content !== GREETING)
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question, history }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: data.error ?? 'Something went wrong.',
            hint: data.hint ?? data.details,
            error: true,
          },
        ]);
      } else {
        setMeta(data.meta);
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: data.answer,
            charts: data.charts,
            trace: data.trace,
            meta: data.meta,
          },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'Could not reach the agent.',
          hint: 'Check your network connection and try again.',
          error: true,
        },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  const showSuggestions = messages.length <= 1;

  return (
    <div className="flex h-dvh flex-col bg-ink-950 text-slate-200">
      <header className="flex shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-900/80 px-4 py-2.5 backdrop-blur sm:px-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 text-sm font-bold text-white">
          S
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white">Skylark BI Agent</p>
          <p className="truncate text-xs text-slate-500">
            {meta
              ? `${meta.deals} deals · ${meta.workOrders} work orders`
              : 'Live business intelligence'}
          </p>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {meta?.isMock && (
            <span className="rounded-full border border-amber-700/50 bg-amber-950/60 px-2 py-0.5 text-[11px] font-medium text-amber-400">
              Sample data
            </span>
          )}
          <span className="hidden items-center gap-1.5 text-xs text-slate-500 sm:flex">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                meta ? 'bg-emerald-400' : 'bg-slate-600'
              } ${loading ? 'animate-pulse' : ''}`}
            />
            {meta ? (meta.isMock ? 'Sample data' : 'Live from Monday.com') : 'Ready'}
          </span>

          {messages.length > 1 && (
            <button
              onClick={startOver}
              className="rounded-md border border-ink-700 px-2.5 py-1 text-xs text-slate-400 transition-colors hover:border-ink-600 hover:text-slate-200"
            >
              New chat
            </button>
          )}
        </div>
      </header>

      {meta?.schemaWarnings?.length ? (
        <div className="shrink-0 border-b border-amber-900/40 bg-amber-950/30 px-4 py-1.5 text-xs text-amber-400 sm:px-6">
          {meta.schemaWarnings.length} column
          {meta.schemaWarnings.length === 1 ? ' was' : 's were'} not recognised on your
          boards, so some figures may be incomplete.
        </div>
      ) : null}

      <main className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={
                  msg.role === 'user'
                    ? 'max-w-[85%] rounded-2xl rounded-br-md bg-sky-600 px-4 py-2.5 text-sm text-white'
                    : msg.error
                      ? 'max-w-[95%] rounded-2xl rounded-bl-md border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200'
                      : 'max-w-[95%] rounded-2xl rounded-bl-md bg-ink-850 px-4 py-3 text-sm'
                }
              >
                {msg.role === 'user' ? (
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                ) : msg.error ? (
                  <>
                    <p className="font-medium">{msg.content}</p>
                    {msg.hint && <p className="mt-1 text-xs text-red-300/80">{msg.hint}</p>}
                  </>
                ) : (
                  <>
                    <Markdown text={msg.content} />
                    {msg.charts && <Charts specs={msg.charts} />}
                    {msg.trace && <ToolTrace trace={msg.trace} />}
                    {msg.trace && (
                      <div className="mt-2 flex justify-end">
                        <CopyButton text={msg.content} />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-ink-850 px-4 py-3">
                {[0, 120, 240].map((d) => (
                  <span
                    key={d}
                    className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400"
                    style={{ animationDelay: `${d}ms` }}
                  />
                ))}
                <span className="ml-1 text-xs text-slate-500">
                  Reading your boards…
                </span>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </main>

      <footer className="shrink-0 px-4 pb-4 sm:px-6">
        <div className="mx-auto max-w-3xl">
          {showSuggestions && (
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {SUGGESTED.map((q) => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  className="rounded-full border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-slate-400 transition-colors hover:border-ink-600 hover:text-slate-200"
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2 rounded-xl border border-ink-700 bg-ink-850 p-2 focus-within:border-ink-600">
            <textarea
              ref={inputRef}
              value={input}
              rows={1}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder="Ask about pipeline, projects, revenue or collections…"
              disabled={loading}
              className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 disabled:opacity-50"
            />
            <button
              onClick={() => send(input)}
              disabled={loading || !input.trim()}
              className="shrink-0 rounded-lg bg-sky-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-30"
            >
              Send
            </button>
          </div>

          <p className="mt-1.5 text-center text-[11px] text-slate-600">
            Every figure comes straight from your Monday.com boards — never estimated.
          </p>
        </div>
      </footer>
    </div>
  );
}
