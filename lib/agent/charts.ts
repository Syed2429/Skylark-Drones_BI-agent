import { formatINR } from '@/lib/cleaner/utils';

/**
 * Chart specs derived from tool results.
 *
 * Built in TypeScript from the same computed figures the answer quotes — the
 * model never produces or influences a chart. A visual that disagreed with the
 * prose would be worse than no visual at all.
 */

export interface BarRow {
  label: string;
  value: number;
  valueLabel: string;
  /** Records that actually carried a value, when that is below 100%. */
  coverage?: { have: number; total: number };
}

export type ChartSpec =
  | {
      kind: 'kpi';
      title: string;
      tiles: Array<{ label: string; value: string; sub?: string; tone?: 'default' | 'warn' }>;
    }
  | {
      kind: 'bar';
      title: string;
      subtitle?: string;
      unit: 'currency' | 'count';
      rows: BarRow[];
      /** Shown under the chart when some rows are incomplete. */
      note?: string;
    };

interface Measure {
  sum: number;
  count: number;
  countWithValue: number;
  coveragePct: number;
}

interface AggregateResult {
  total?: { count: number; measure: Measure | null };
  groups?: Array<{ key: string; count: number; measure: Measure | null }>;
}

const MAX_BARS = 8;

function isCurrencyMetric(metric: unknown): boolean {
  return typeof metric === 'string' && metric !== 'count';
}

/** Folds the long tail into "Other" rather than rendering a 20-bar chart. */
function foldTail(rows: BarRow[], unit: 'currency' | 'count'): BarRow[] {
  if (rows.length <= MAX_BARS) return rows;

  const head = rows.slice(0, MAX_BARS - 1);
  const tail = rows.slice(MAX_BARS - 1);
  const sum = tail.reduce((a, r) => a + r.value, 0);

  head.push({
    label: `Other (${tail.length})`,
    value: sum,
    valueLabel: unit === 'currency' ? formatINR(sum) : String(sum),
  });
  return head;
}

function barsFromAggregate(
  result: AggregateResult,
  metric: unknown,
  title: string,
  subtitle?: string
): ChartSpec | null {
  const groups = result.groups ?? [];
  if (groups.length < 2) return null;

  const currency = isCurrencyMetric(metric);
  const unit: 'currency' | 'count' = currency ? 'currency' : 'count';

  let rows: BarRow[] = groups.map((g) => {
    const value = currency ? (g.measure?.sum ?? 0) : g.count;
    return {
      label: g.key,
      value,
      valueLabel: currency ? formatINR(value) : String(value),
      coverage:
        currency && g.measure && g.measure.coveragePct < 100
          ? { have: g.measure.countWithValue, total: g.measure.count }
          : undefined,
    };
  });

  rows = rows.filter((r) => r.value !== 0 || !currency).sort((a, b) => b.value - a.value);
  if (rows.length < 2) return null;

  rows = foldTail(rows, unit);

  const incomplete = rows.filter((r) => r.coverage).length;

  return {
    kind: 'bar',
    title,
    subtitle,
    unit,
    rows,
    note: incomplete
      ? `${incomplete} of these categories contain records with no value recorded, so those bars are minimums.`
      : undefined,
  };
}

const DEAL_METRIC_TITLES: Record<string, string> = {
  count: 'Number of deals',
  dealValue: 'Deal value',
};

const WO_METRIC_TITLES: Record<string, string> = {
  count: 'Number of work orders',
  contractValueExclGst: 'Contract value',
  contractValueInclGst: 'Contract value (incl GST)',
  billedExclGst: 'Amount invoiced',
  billedInclGst: 'Amount invoiced (incl GST)',
  collectedInclGst: 'Cash collected',
  receivable: 'Money still owed',
  toBeBilledExclGst: 'Still to invoice',
};

const GROUP_TITLES: Record<string, string> = {
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
  poQuarter: 'by quarter received',
  executionStatus: 'by delivery status',
  natureOfWork: 'by contract type',
  invoiceStatus: 'by invoice status',
  billingStatus: 'by billing status',
  woStatusBilled: 'by work order status',
  skylarkSoftware: 'by software included',
  typeOfWork: 'by type of work',
};

interface PackTotal {
  count: number;
  value?: string;
  valued?: string;
  isFloor?: boolean;
}

interface LeadershipPack {
  pipeline: {
    open: PackTotal;
    openByStage: Array<{ label: string; count: number; value?: string }>;
    openBySector: Array<{ label: string; count: number; value?: string }>;
  };
  execution: { workOrdersTotal: number; byStatus: Array<{ label: string; count: number }> };
  money: Record<string, PackTotal | string>;
  sectors: { workOrderRevenue: Array<{ label: string; count: number; value?: string }> };
  risks: { byKind: Array<{ kind: string; count: number; atStake: string }> };
}

/** Parses "₹1.23 Cr" / "₹4.56 L" back to a number, for bar lengths. */
function parseFormattedINR(s: string | undefined): number {
  if (!s) return 0;
  const m = s.replace(/[₹,\s]/g, '').match(/^(-?[\d.]+)(Cr|L)?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  if (/cr/i.test(m[2] ?? '')) return n * 10_000_000;
  if (/^l$/i.test(m[2] ?? '')) return n * 100_000;
  return n;
}

function chartsFromPack(pack: LeadershipPack): ChartSpec[] {
  const out: ChartSpec[] = [];
  const money = pack.money as Record<string, PackTotal>;

  const tile = (key: string, label: string) => {
    const t = money[key];
    if (!t?.value) return null;
    return {
      label,
      value: t.value,
      sub: t.isFloor && t.valued ? `${t.valued} recorded` : undefined,
      tone: (t.isFloor ? 'warn' : 'default') as 'default' | 'warn',
    };
  };

  const tiles = [
    tile('orderBookExclGst', 'Order book'),
    tile('billedExclGst', 'Invoiced'),
    tile('collectedInclGst', 'Collected'),
    tile('receivable', 'Still owed'),
    tile('yetToBillExclGst', 'Yet to invoice'),
  ].filter((t): t is NonNullable<typeof t> => t !== null);

  if (tiles.length) out.push({ kind: 'kpi', title: 'Money at a glance', tiles });

  const fromPackRows = (
    rows: Array<{ label: string; count: number; value?: string }> | undefined,
    title: string,
    subtitle: string
  ): ChartSpec | null => {
    if (!rows?.length) return null;
    const mapped: BarRow[] = rows
      .filter((r) => r.value)
      .map((r) => ({
        label: r.label,
        value: parseFormattedINR(r.value),
        valueLabel: r.value as string,
      }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);

    if (mapped.length < 2) return null;
    return { kind: 'bar', title, subtitle, unit: 'currency', rows: foldTail(mapped, 'currency') };
  };

  const bySector = fromPackRows(
    pack.pipeline.openBySector,
    'Open pipeline',
    'by sector, value recorded so far'
  );
  if (bySector) out.push(bySector);

  const byStage = fromPackRows(
    pack.pipeline.openByStage,
    'Open pipeline',
    'by funnel stage'
  );
  if (byStage) out.push(byStage);

  const woRevenue = fromPackRows(
    pack.sectors.workOrderRevenue,
    'Delivered work',
    'contract value by sector'
  );
  if (woRevenue) out.push(woRevenue);

  const delivery = pack.execution.byStatus ?? [];
  if (delivery.length >= 2) {
    out.push({
      kind: 'bar',
      title: 'Project delivery',
      subtitle: `${pack.execution.workOrdersTotal} work orders by status`,
      unit: 'count',
      rows: foldTail(
        delivery
          .map((d) => ({ label: d.label, value: d.count, valueLabel: String(d.count) }))
          .sort((a, b) => b.value - a.value),
        'count'
      ),
    });
  }

  const risks = pack.risks?.byKind ?? [];
  if (risks.length >= 2) {
    out.push({
      kind: 'bar',
      title: 'What needs attention',
      subtitle: 'number of items flagged',
      unit: 'count',
      rows: foldTail(
        risks
          .map((r) => ({ label: r.kind, value: r.count, valueLabel: `${r.count} · ${r.atStake}` }))
          .sort((a, b) => b.value - a.value),
        'count'
      ),
    });
  }

  return out;
}

export interface GatheredCall {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export function buildCharts(gathered: GatheredCall[]): ChartSpec[] {
  const charts: ChartSpec[] = [];

  for (const g of gathered) {
    if (g.tool === 'leadership_pack') {
      charts.push(...chartsFromPack(g.result as LeadershipPack));
      continue;
    }

    if (g.tool === 'aggregate_deals' || g.tool === 'aggregate_work_orders') {
      const isDeals = g.tool === 'aggregate_deals';
      const metric = g.args.metric ?? 'count';
      const groupBy = String(g.args.groupBy ?? '');
      if (!groupBy) continue;

      const titles = isDeals ? DEAL_METRIC_TITLES : WO_METRIC_TITLES;
      const chart = barsFromAggregate(
        g.result as AggregateResult,
        metric,
        titles[String(metric)] ?? (isDeals ? 'Deals' : 'Work orders'),
        GROUP_TITLES[groupBy] ?? groupBy
      );
      if (chart) charts.push(chart);
    }

    if (g.tool === 'find_risks') {
      const r = g.result as { summaryByKind?: Array<{ kind: string; count: number; amountFormatted: string }> };
      const kinds = r.summaryByKind ?? [];
      if (kinds.length >= 2) {
        charts.push({
          kind: 'bar',
          title: 'What needs attention',
          subtitle: 'number of items flagged',
          unit: 'count',
          rows: foldTail(
            kinds
              .map((k) => ({
                label: k.kind,
                value: k.count,
                valueLabel: `${k.count} · ${k.amountFormatted}`,
              }))
              .sort((a, b) => b.value - a.value),
            'count'
          ),
        });
      }
    }
  }

  // Two identical charts add nothing; the backstop can legitimately duplicate one.
  const seen = new Set<string>();
  return charts.filter((c) => {
    const key = `${c.kind}:${c.title}:${'subtitle' in c ? c.subtitle : ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
