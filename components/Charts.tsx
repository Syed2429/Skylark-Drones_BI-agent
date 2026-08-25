'use client';

import { useState } from 'react';
import type { ChartSpec } from '@/lib/agent/charts';

/**
 * Charts for the answers.
 *
 * Every value here was computed by the query engine — the model neither produces
 * nor influences a chart, so a visual can never disagree with the prose above it.
 *
 * Colour: a single-hue ordinal blue ramp (more = brighter on a dark surface),
 * validated against the app surface for monotone lightness, step separation and
 * contrast. One series per chart, so identity never rests on colour: the title
 * names the measure and every bar is directly labelled.
 */

/**
 * One hue for every bar.
 *
 * Bar length already encodes magnitude, so shading bars by rank would be
 * redundant double-encoding — and it repaints the survivors whenever the set
 * changes. Validated at 3:1+ against the chart surface in dark mode.
 */
const BAR = '#3987e5';

function KpiRow({ spec }: { spec: Extract<ChartSpec, { kind: 'kpi' }> }) {
  return (
    <section className="mt-3">
      <h3 className="mb-2 text-xs font-medium text-slate-400">{spec.title}</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {spec.tiles.map((t) => (
          <div
            key={t.label}
            className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5"
          >
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{t.label}</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-white">{t.value}</p>
            {t.sub && (
              <p className={`text-[11px] ${t.tone === 'warn' ? 'text-amber-400/80' : 'text-slate-500'}`}>
                {t.sub}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function BarChart({ spec }: { spec: Extract<ChartSpec, { kind: 'bar' }> }) {
  const [showTable, setShowTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  const max = Math.max(...spec.rows.map((r) => r.value), 1);

  return (
    <section className="mt-3 rounded-lg border border-ink-700 bg-ink-900 px-3 py-3">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h3 className="text-xs font-medium text-slate-300">{spec.title}</h3>
        {spec.subtitle && <span className="text-[11px] text-slate-500">{spec.subtitle}</span>}
        <button
          onClick={() => setShowTable((v) => !v)}
          className="ml-auto shrink-0 text-[11px] text-slate-500 transition-colors hover:text-slate-300"
        >
          {showTable ? 'Chart' : 'Table'}
        </button>
      </div>

      {showTable ? (
        <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-ink-700 text-left text-slate-500">
              <th className="pb-1 font-medium">Category</th>
              <th className="pb-1 text-right font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {spec.rows.map((r) => (
              <tr key={r.label} className="border-b border-ink-800/60 last:border-0">
                <td className="py-1 pr-2 text-slate-300">{r.label}</td>
                <td className="py-1 text-right tabular-nums text-slate-200">
                  {r.valueLabel}
                  {r.coverage && (
                    <span className="ml-1 text-[10px] text-amber-400/70">
                      ({r.coverage.have}/{r.coverage.total})
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {spec.rows.map((r, i) => {
            const pct = Math.max((r.value / max) * 100, 1.5);
            const active = hover === i;
            return (
              <li
                key={r.label}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                className="group relative"
              >
                <div className="flex items-baseline justify-between gap-3">
                  {/* min-w-0 is required: a flex item defaults to min-width:auto,
                      so without it a long category name refuses to shrink and
                      shoves the value off the row instead of truncating. */}
                  <span className="min-w-0 truncate text-[11px] text-slate-400" title={r.label}>
                    {r.label}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-slate-300">
                    {r.valueLabel}
                  </span>
                </div>
                <div className="mt-0.5 h-2 w-full overflow-hidden rounded-sm bg-ink-800">
                  <div
                    className="h-full rounded-sm transition-[width,opacity] duration-300"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: BAR,
                      opacity: hover === null || active ? 1 : 0.55,
                    }}
                  />
                </div>

                {active && r.coverage && (
                  <p className="mt-0.5 text-[10px] text-amber-400/80">
                    {r.coverage.have} of {r.coverage.total} records have a value recorded — the
                    real figure is higher
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {spec.note && !showTable && (
        <p className="mt-2 text-[10px] leading-snug text-slate-500">{spec.note}</p>
      )}
    </section>
  );
}

export function Charts({ specs }: { specs: ChartSpec[] }) {
  if (!specs?.length) return null;

  return (
    <div className="mt-1">
      {specs.map((spec, i) =>
        spec.kind === 'kpi' ? (
          <KpiRow key={i} spec={spec} />
        ) : (
          <BarChart key={i} spec={spec} />
        )
      )}
    </div>
  );
}
