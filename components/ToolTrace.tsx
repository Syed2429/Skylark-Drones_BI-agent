'use client';

import { useState } from 'react';

export interface TraceEntry {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  summary: string;
  durationMs: number;
}

/**
 * "How I worked this out" — the audit trail, written for a business reader.
 *
 * The panel exists so a founder can sanity-check where a number came from, so it
 * must not read like a developer log. Tool names, JSON arguments and field names
 * are translated into the words someone would actually use to describe the step.
 */

const METRIC_WORDS: Record<string, string> = {
  count: 'how many',
  dealValue: 'deal value',
  contractValueExclGst: 'contract value',
  contractValueInclGst: 'contract value including GST',
  billedExclGst: 'amount invoiced',
  billedInclGst: 'amount invoiced including GST',
  collectedInclGst: 'cash collected',
  receivable: 'money still owed',
  toBeBilledExclGst: 'work still to invoice',
};

const GROUP_WORDS: Record<string, string> = {
  sector: 'by sector',
  dealStatus: 'by status',
  dealStage: 'by funnel stage',
  ownerCode: 'by owner',
  bdPersonnelCode: 'by owner',
  closureProbability: 'by likelihood of closing',
  productDeal: 'by product',
  clientCode: 'by client',
  customerCode: 'by customer',
  closeQuarter: 'by expected closing quarter',
  poQuarter: 'by quarter the order came in',
  executionStatus: 'by delivery status',
  natureOfWork: 'by contract type',
  invoiceStatus: 'by invoice status',
  billingStatus: 'by billing status',
  woStatusBilled: 'by work order status',
  skylarkSoftware: 'by software included',
  typeOfWork: 'by type of work',
};

/** Turns a filter object into a phrase like "Open deals · Mining, Renewables · this quarter". */
function describeFilter(args: Record<string, unknown>): string {
  const f = (args.filter ?? {}) as Record<string, unknown>;
  const bits: string[] = [];

  const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));

  if (f.status) bits.push(`${list(f.status)} deals`);
  if (f.executionStatus) bits.push(list(f.executionStatus));
  if (f.activeFunnelOnly) bits.push('still-winnable stages');
  if (f.inFlightOnly) bits.push('not yet delivered');
  if (f.sector) bits.push(list(f.sector));
  if (f.stage) bits.push(list(f.stage));
  if (f.owner) bits.push(`owner ${list(f.owner)}`);
  if (f.client) bits.push(`client ${list(f.client)}`);
  if (f.customer) bits.push(`customer ${list(f.customer)}`);
  if (f.probability) bits.push(`${list(f.probability)} likelihood`);
  if (f.natureOfWork) bits.push(list(f.natureOfWork));
  if (f.invoiceStatus) bits.push(`invoices ${list(f.invoiceStatus)}`);
  if (f.billingStatus) bits.push(`billing ${list(f.billingStatus)}`);
  if (f.woStatus) bits.push(`work orders ${list(f.woStatus)}`);
  if (f.typeOfWorkPattern) bits.push(`work involving ${f.typeOfWorkPattern}`);
  if (f.namePattern) bits.push(`named like "${f.namePattern}"`);
  if (f.arPriorityOnly) bits.push('priority accounts only');
  if (f.hasReceivable) bits.push('with money outstanding');
  if (f.hasValue === true) bits.push('with a recorded value');
  if (f.hasValue === false) bits.push('with no recorded value');
  if (f.period) bits.push(String(f.period));

  if (args.severity && args.severity !== 'all') bits.push(`${args.severity} severity`);
  if (args.kind) bits.push(String(args.kind));

  return bits.join(' · ');
}

function describeStep(entry: TraceEntry): string {
  const { name, arguments: args } = entry;
  const metric = METRIC_WORDS[String(args.metric ?? 'count')] ?? 'totals';
  const grouped = args.groupBy ? ` ${GROUP_WORDS[String(args.groupBy)] ?? ''}`.trimEnd() : '';

  switch (name) {
    case 'leadership_pack':
      return 'Pulled the full picture from both boards — pipeline, delivery, invoicing, collections, risks and data quality';
    case 'describe_data':
      return 'Checked what is actually recorded on both boards';
    case 'data_quality_report':
      return 'Checked how complete and trustworthy the underlying data is';
    case 'aggregate_deals':
      return args.metric === 'count' || !args.metric
        ? `Counted deals${grouped}`
        : `Totalled ${metric} on the sales pipeline${grouped}`;
    case 'aggregate_work_orders':
      return args.metric === 'count' || !args.metric
        ? `Counted work orders${grouped}`
        : `Totalled ${metric} on work orders${grouped}`;
    case 'list_deals':
      return 'Pulled the individual deals that match';
    case 'list_work_orders':
      return 'Pulled the individual work orders that match';
    case 'cross_board_view':
      return 'Matched deals against their work orders';
    case 'find_risks':
      return 'Scanned both boards for things at risk';
    default:
      return name.replace(/_/g, ' ');
  }
}

export function ToolTrace({ trace }: { trace: TraceEntry[] }) {
  const [open, setOpen] = useState(false);
  if (!trace.length) return null;

  const autoAdded = trace.some((t) => t.arguments.autoAdded);

  return (
    <div className="mt-3 border-t border-ink-700 pt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-slate-300"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        How I worked this out
      </button>

      {open && (
        <ol className="mt-2 space-y-1.5">
          {trace.map((t, i) => {
            const filter = describeFilter(t.arguments);
            return (
              <li key={i} className="rounded-md bg-ink-900 px-2.5 py-1.5 text-xs">
                <div className="flex items-baseline gap-2">
                  <span className={t.ok ? 'text-emerald-400' : 'text-red-400'}>
                    {t.ok ? '✓' : '✕'}
                  </span>
                  <span className="text-slate-300">{describeStep(t)}</span>
                </div>
                {filter && <p className="mt-0.5 pl-5 text-[11px] text-slate-500">{filter}</p>}
                <p className="pl-5 text-[11px] text-slate-400">{t.summary}</p>
              </li>
            );
          })}
        </ol>
      )}

      {open && autoAdded && (
        <p className="mt-2 text-[11px] text-slate-500">
          Some figures were added automatically so the comparison covered both boards.
        </p>
      )}
    </div>
  );
}
