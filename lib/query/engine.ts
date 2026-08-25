import type { CleanDeal, CleanWorkOrder, Dataset } from '@/lib/monday/types';
import { formatINR } from '@/lib/cleaner/utils';
import {
  ACTIVE_FUNNEL_STAGES,
  DEAL_STAGE_ORDER,
  IN_FLIGHT_EXECUTION_STATUSES,
  resolveSectorTerm,
} from '@/lib/cleaner/taxonomy';
import {
  fiscalQuarterOf,
  fiscalYearLabel,
  fiscalYearOf,
  isWithin,
  resolvePeriod,
  today,
  type Period,
} from './dates';

// ─── Coverage-aware aggregation ───────────────────────────────────────────────

/**
 * Every numeric result carries its own coverage. A sum over a column that is
 * half empty is not wrong, but it IS a floor rather than a total — and the
 * agent can only say so if the number arrives with that context attached.
 */
export interface Measure {
  sum: number;
  average: number | null;
  min: number | null;
  max: number | null;
  /** Rows in the group. */
  count: number;
  /** Rows whose value was actually populated. */
  countWithValue: number;
  countMissing: number;
  /** 0-100. Below 100 means `sum` understates reality. */
  coveragePct: number;
  formatted: string;
}

function measure(values: Array<number | null>, currency = true): Measure {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const sum = present.reduce((a, b) => a + b, 0);
  const count = values.length;
  const countWithValue = present.length;

  return {
    sum: round2(sum),
    average: countWithValue ? round2(sum / countWithValue) : null,
    min: countWithValue ? round2(Math.min(...present)) : null,
    max: countWithValue ? round2(Math.max(...present)) : null,
    count,
    countWithValue,
    countMissing: count - countWithValue,
    coveragePct: count ? Math.round((countWithValue / count) * 1000) / 10 : 0,
    formatted: currency ? formatINR(sum) : String(round2(sum)),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Filters ──────────────────────────────────────────────────────────────────

export interface DealFilter {
  status?: string[];
  stage?: string[];
  /** Convenience: only stages that are still winnable. */
  activeFunnelOnly?: boolean;
  sector?: string[];
  owner?: string[];
  client?: string[];
  probability?: string[];
  product?: string[];
  namePattern?: string;
  minValue?: number;
  maxValue?: number;
  hasValue?: boolean;
  /** Which date column the period applies to. */
  dateField?: 'tentativeCloseDate' | 'createdDate' | 'closeDateActual';
  period?: string;
}

export interface WorkOrderFilter {
  executionStatus?: string[];
  /** Convenience: work still owed to the customer. */
  inFlightOnly?: boolean;
  sector?: string[];
  owner?: string[];
  customer?: string[];
  natureOfWork?: string[];
  invoiceStatus?: string[];
  billingStatus?: string[];
  woStatus?: string[];
  typeOfWorkPattern?: string;
  namePattern?: string;
  arPriorityOnly?: boolean;
  hasReceivable?: boolean;
  minAmount?: number;
  maxAmount?: number;
  dateField?: 'poDate' | 'probableStartDate' | 'probableEndDate' | 'lastInvoiceDate' | 'dataDeliveryDate';
  period?: string;
}

export interface FilterResolution {
  /** Interpretations the agent must disclose, e.g. how "energy" was mapped. */
  notes: string[];
  period: Period | null;
  /** Set when a period string could not be parsed. */
  unresolvedPeriod: string | null;
  unmatchedSectors: string[];
  /**
   * Filters that could not be applied. Non-empty means the result covers a
   * WIDER scope than was asked for, so it must not be reported as the answer.
   */
  droppedFilters: string[];
  /** Filter values that exist nowhere on the board. A zero here means "no such thing". */
  unknownValues: string[];
}

function emptyResolution(): FilterResolution {
  return {
    notes: [],
    period: null,
    unresolvedPeriod: null,
    unmatchedSectors: [],
    droppedFilters: [],
    unknownValues: [],
  };
}

/**
 * Flags filter values that exist nowhere on the board.
 *
 * Without this, asking about "OWNER_099" — who does not exist — returns a count
 * of 0, and a zero reads as "this person has no pipeline" rather than "there is
 * no such person". Those mean opposite things to a founder, so the difference is
 * detected in code rather than left to the model to notice.
 */
function checkKnownValues<T>(
  rows: T[],
  field: keyof T,
  requested: string[] | undefined,
  label: string,
  res: FilterResolution
): void {
  if (!requested?.length) return;

  const present = new Set(
    rows
      .map((r) => r[field] as unknown as string | null)
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.toLowerCase().trim())
  );

  const unknown = requested.filter((v) => !present.has(v.toLowerCase().trim()));
  if (unknown.length) {
    res.unknownValues.push(
      `${label} ${unknown.map((u) => `"${u}"`).join(', ')} ${unknown.length === 1 ? 'does' : 'do'} not exist on this board — this is not a zero, it is a value that was never recorded. Do not describe it as underperformance.`
    );
  }
}

function eqAny(value: string | null, allowed: string[] | undefined): boolean {
  if (!allowed?.length) return true;
  if (value === null) return false;
  const v = value.toLowerCase().trim();
  return allowed.some((a) => a.toLowerCase().trim() === v);
}

function matchesPattern(value: string | null, pattern: string | undefined): boolean {
  if (!pattern) return true;
  if (value === null) return false;
  return value.toLowerCase().includes(pattern.toLowerCase().trim());
}

function expandSectors(
  input: string[] | undefined,
  res: FilterResolution
): string[] | undefined {
  if (!input?.length) return undefined;
  const out = new Set<string>();
  for (const term of input) {
    const { sectors, note } = resolveSectorTerm(term);
    if (note) res.notes.push(note);
    if (!sectors.length) {
      res.unmatchedSectors.push(term);
      res.droppedFilters.push(`sector "${term}" matched nothing`);
    }
    sectors.forEach((s) => out.add(s));
  }
  return out.size ? [...out] : [];
}

function applyPeriod(filterPeriod: string | undefined, res: FilterResolution): Period | null {
  if (!filterPeriod) return null;
  const period = resolvePeriod(filterPeriod);
  if (!period) {
    res.unresolvedPeriod = filterPeriod;
    res.droppedFilters.push(
      `period "${filterPeriod}" could not be parsed, so NO date filter was applied — these figures span all dates`
    );
    return null;
  }
  if (period.note) res.notes.push(period.note);
  res.period = period;
  return period;
}

export function filterDeals(
  deals: CleanDeal[],
  f: DealFilter
): { rows: CleanDeal[]; resolution: FilterResolution } {
  const res: FilterResolution = emptyResolution();

  const sectors = expandSectors(f.sector, res);
  const period = applyPeriod(f.period, res);
  const dateField = f.dateField ?? 'tentativeCloseDate';

  if (period && dateField === 'tentativeCloseDate') {
    res.notes.push(
      'Deal timing uses Tentative Close Date. Close Date (A) is populated on only ~8% of deals, so it cannot carry period filters.'
    );
  }

  checkKnownValues(deals, 'ownerCode', f.owner, 'Owner code', res);
  checkKnownValues(deals, 'clientCode', f.client, 'Client code', res);
  checkKnownValues(deals, 'dealStage', f.stage, 'Deal stage', res);

  const rows = deals.filter((d) => {
    if (!eqAny(d.dealStatus, f.status)) return false;
    if (!eqAny(d.dealStage, f.stage)) return false;
    if (f.activeFunnelOnly && !(d.dealStage && ACTIVE_FUNNEL_STAGES.has(d.dealStage))) return false;
    if (sectors && !eqAny(d.sector, sectors)) return false;
    if (!eqAny(d.ownerCode, f.owner)) return false;
    if (!eqAny(d.clientCode, f.client)) return false;
    if (!eqAny(d.closureProbability, f.probability)) return false;
    if (!eqAny(d.productDeal, f.product)) return false;
    if (!matchesPattern(d.dealName, f.namePattern)) return false;
    if (f.hasValue === true && d.dealValue === null) return false;
    if (f.hasValue === false && d.dealValue !== null) return false;
    if (f.minValue !== undefined && (d.dealValue ?? -Infinity) < f.minValue) return false;
    if (f.maxValue !== undefined && (d.dealValue ?? Infinity) > f.maxValue) return false;
    if (period && !isWithin(d[dateField], period)) return false;
    return true;
  });

  return { rows, resolution: res };
}

export function filterWorkOrders(
  wos: CleanWorkOrder[],
  f: WorkOrderFilter
): { rows: CleanWorkOrder[]; resolution: FilterResolution } {
  const res: FilterResolution = emptyResolution();

  const sectors = expandSectors(f.sector, res);
  const period = applyPeriod(f.period, res);
  const dateField = f.dateField ?? 'poDate';

  checkKnownValues(wos, 'bdPersonnelCode', f.owner, 'BD/KAM code', res);
  checkKnownValues(wos, 'customerCode', f.customer, 'Customer code', res);
  checkKnownValues(wos, 'executionStatus', f.executionStatus, 'Execution status', res);

  const rows = wos.filter((w) => {
    if (!eqAny(w.executionStatus, f.executionStatus)) return false;
    if (f.inFlightOnly && !(w.executionStatus && IN_FLIGHT_EXECUTION_STATUSES.has(w.executionStatus)))
      return false;
    if (sectors && !eqAny(w.sector, sectors)) return false;
    if (!eqAny(w.bdPersonnelCode, f.owner)) return false;
    if (!eqAny(w.customerCode, f.customer)) return false;
    if (!eqAny(w.natureOfWork, f.natureOfWork)) return false;
    if (!eqAny(w.invoiceStatus, f.invoiceStatus)) return false;
    if (!eqAny(w.billingStatus, f.billingStatus)) return false;
    if (!eqAny(w.woStatusBilled, f.woStatus)) return false;
    if (!matchesPattern(w.typeOfWork, f.typeOfWorkPattern)) return false;
    if (!matchesPattern(w.dealNameMasked, f.namePattern)) return false;
    if (f.arPriorityOnly && !w.arPriority) return false;
    if (f.hasReceivable && !(w.amountReceivable !== null && w.amountReceivable > 0)) return false;
    if (f.minAmount !== undefined && (w.amountExclGst ?? -Infinity) < f.minAmount) return false;
    if (f.maxAmount !== undefined && (w.amountExclGst ?? Infinity) > f.maxAmount) return false;
    if (period && !isWithin(w[dateField], period)) return false;
    return true;
  });

  return { rows, resolution: res };
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export const DEAL_METRICS = {
  count: null,
  dealValue: (d: CleanDeal) => d.dealValue,
} as const;

export const WO_METRICS = {
  count: null,
  contractValueExclGst: (w: CleanWorkOrder) => w.amountExclGst,
  contractValueInclGst: (w: CleanWorkOrder) => w.amountInclGst,
  billedExclGst: (w: CleanWorkOrder) => w.billedExclGst,
  billedInclGst: (w: CleanWorkOrder) => w.billedInclGst,
  collectedInclGst: (w: CleanWorkOrder) => w.collectedAmount,
  receivable: (w: CleanWorkOrder) => w.amountReceivable,
  toBeBilledExclGst: (w: CleanWorkOrder) => w.amountToBeBilledExcl,
} as const;

export type DealMetric = keyof typeof DEAL_METRICS;
export type WoMetric = keyof typeof WO_METRICS;

export const DEAL_GROUPABLE = [
  'sector',
  'dealStatus',
  'dealStage',
  'ownerCode',
  'closureProbability',
  'productDeal',
  'clientCode',
  'closeQuarter',
] as const;

export const WO_GROUPABLE = [
  'sector',
  'executionStatus',
  'bdPersonnelCode',
  'natureOfWork',
  'invoiceStatus',
  'billingStatus',
  'woStatusBilled',
  'customerCode',
  'skylarkSoftware',
  'typeOfWork',
  'poQuarter',
] as const;

export type DealGroupBy = (typeof DEAL_GROUPABLE)[number];
export type WoGroupBy = (typeof WO_GROUPABLE)[number];

function quarterKey(iso: string | null): string {
  if (!iso) return '(no date)';
  return `Q${fiscalQuarterOf(iso)} ${fiscalYearLabel(fiscalYearOf(iso))}`;
}

function dealGroupKey(d: CleanDeal, by: DealGroupBy): string {
  if (by === 'closeQuarter') return quarterKey(d.tentativeCloseDate);
  return (d[by] as string | null) ?? '(not set)';
}

function woGroupKey(w: CleanWorkOrder, by: WoGroupBy): string {
  if (by === 'poQuarter') return quarterKey(w.poDate);
  return (w[by] as string | null) ?? '(not set)';
}

export interface GroupResult {
  key: string;
  count: number;
  measure: Measure | null;
}

export interface AggregateResult {
  total: { count: number; measure: Measure | null };
  groups: GroupResult[];
  resolution: FilterResolution;
  /** Human-readable statement of exactly what was counted. */
  scope: string;
}

function sortGroups(groups: GroupResult[], by: string, metricIsCount: boolean): GroupResult[] {
  if (by === 'dealStage') {
    return groups.sort((a, b) => {
      const ia = DEAL_STAGE_ORDER.indexOf(a.key);
      const ib = DEAL_STAGE_ORDER.indexOf(b.key);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
  }
  return groups.sort((a, b) =>
    metricIsCount ? b.count - a.count : (b.measure?.sum ?? 0) - (a.measure?.sum ?? 0)
  );
}

export function aggregateDeals(
  deals: CleanDeal[],
  filter: DealFilter,
  metric: DealMetric = 'count',
  groupBy?: DealGroupBy
): AggregateResult {
  const { rows, resolution } = filterDeals(deals, filter);
  const extract = metric === 'count' ? null : DEAL_METRICS[metric];

  const total = {
    count: rows.length,
    measure: extract ? measure(rows.map(extract)) : null,
  };

  let groups: GroupResult[] = [];
  if (groupBy) {
    const buckets = new Map<string, CleanDeal[]>();
    for (const d of rows) {
      const k = dealGroupKey(d, groupBy);
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(d);
    }
    groups = sortGroups(
      [...buckets.entries()].map(([key, items]) => ({
        key,
        count: items.length,
        measure: extract ? measure(items.map(extract)) : null,
      })),
      groupBy,
      metric === 'count'
    );
  }

  return { total, groups, resolution, scope: describeDealScope(filter, resolution) };
}

export function aggregateWorkOrders(
  wos: CleanWorkOrder[],
  filter: WorkOrderFilter,
  metric: WoMetric = 'count',
  groupBy?: WoGroupBy
): AggregateResult {
  const { rows, resolution } = filterWorkOrders(wos, filter);
  const extract = metric === 'count' ? null : WO_METRICS[metric];

  const total = {
    count: rows.length,
    measure: extract ? measure(rows.map(extract)) : null,
  };

  let groups: GroupResult[] = [];
  if (groupBy) {
    const buckets = new Map<string, CleanWorkOrder[]>();
    for (const w of rows) {
      const k = woGroupKey(w, groupBy);
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(w);
    }
    groups = sortGroups(
      [...buckets.entries()].map(([key, items]) => ({
        key,
        count: items.length,
        measure: extract ? measure(items.map(extract)) : null,
      })),
      groupBy,
      metric === 'count'
    );
  }

  return { total, groups, resolution, scope: describeWoScope(filter, resolution) };
}

function describeDealScope(f: DealFilter, r: FilterResolution): string {
  const bits: string[] = ['deals'];
  if (f.status?.length) bits.push(`status ${f.status.join('/')}`);
  if (f.activeFunnelOnly) bits.push('active funnel stages only');
  if (r.period) bits.push(`${f.dateField ?? 'tentativeCloseDate'} within ${r.period.label}`);
  if (f.sector?.length) bits.push(`sector ${f.sector.join('/')}`);
  if (f.owner?.length) bits.push(`owner ${f.owner.join('/')}`);
  if (f.hasValue === true) bits.push('with a recorded value');
  return bits.join(', ');
}

function describeWoScope(f: WorkOrderFilter, r: FilterResolution): string {
  const bits: string[] = ['work orders'];
  if (f.executionStatus?.length) bits.push(`execution ${f.executionStatus.join('/')}`);
  if (f.inFlightOnly) bits.push('still in flight');
  if (r.period) bits.push(`${f.dateField ?? 'poDate'} within ${r.period.label}`);
  if (f.sector?.length) bits.push(`sector ${f.sector.join('/')}`);
  if (f.owner?.length) bits.push(`BD owner ${f.owner.join('/')}`);
  if (f.arPriorityOnly) bits.push('AR priority accounts only');
  return bits.join(', ');
}

// ─── Listing ──────────────────────────────────────────────────────────────────

export interface ListOptions {
  sortBy?: string;
  direction?: 'asc' | 'desc';
  limit?: number;
}

function compareBy<T>(rows: T[], key: keyof T, direction: 'asc' | 'desc'): T[] {
  return [...rows].sort((a, b) => {
    const av = a[key] as unknown;
    const bv = b[key] as unknown;
    // Nulls always sort last, whichever direction — "no value" is not "smallest".
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === 'number' && typeof bv === 'number') {
      return direction === 'asc' ? av - bv : bv - av;
    }
    const as = String(av);
    const bs = String(bv);
    return direction === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
  });
}

export function listDeals(
  deals: CleanDeal[],
  filter: DealFilter,
  opts: ListOptions = {}
): { rows: CleanDeal[]; totalMatching: number; resolution: FilterResolution } {
  const { rows, resolution } = filterDeals(deals, filter);
  const sorted = opts.sortBy
    ? compareBy(rows, opts.sortBy as keyof CleanDeal, opts.direction ?? 'desc')
    : compareBy(rows, 'dealValue', 'desc');
  return {
    rows: sorted.slice(0, opts.limit ?? 20),
    totalMatching: rows.length,
    resolution,
  };
}

export function listWorkOrders(
  wos: CleanWorkOrder[],
  filter: WorkOrderFilter,
  opts: ListOptions = {}
): { rows: CleanWorkOrder[]; totalMatching: number; resolution: FilterResolution } {
  const { rows, resolution } = filterWorkOrders(wos, filter);
  const sorted = opts.sortBy
    ? compareBy(rows, opts.sortBy as keyof CleanWorkOrder, opts.direction ?? 'desc')
    : compareBy(rows, 'amountExclGst', 'desc');
  return {
    rows: sorted.slice(0, opts.limit ?? 20),
    totalMatching: rows.length,
    resolution,
  };
}

// ─── Cross-board join ─────────────────────────────────────────────────────────

export interface CrossBoardRow {
  dealName: string;
  dealCount: number;
  workOrderCount: number;
  dealSectors: string[];
  woSectors: string[];
  dealValueKnown: number | null;
  woContractValue: number;
  woBilled: number;
  woReceivable: number;
  sectorConflict: boolean;
}

export interface CrossBoardResult {
  matched: CrossBoardRow[];
  dealsOnly: number;
  workOrdersOnly: number;
  matchedDealNames: number;
  totalDealNames: number;
  totalWoNames: number;
  caveat: string;
}

/**
 * Joins the two boards on masked deal name — the only field they share.
 *
 * This join is deliberately many-to-many and reported as indicative, not
 * authoritative: deal names repeat heavily on the Deals board (roughly 155
 * distinct names across ~344 rows), so one name can legitimately correspond to
 * several unrelated deals. Any figure derived from it is a directional signal.
 */
export function crossBoardJoin(
  deals: CleanDeal[],
  wos: CleanWorkOrder[]
): CrossBoardResult {
  const norm = (s: string | null) => (s ? s.toLowerCase().replace(/\s+/g, ' ').trim() : null);

  const dealsByName = new Map<string, CleanDeal[]>();
  for (const d of deals) {
    const k = norm(d.dealName);
    if (!k) continue;
    (dealsByName.get(k) ?? dealsByName.set(k, []).get(k)!).push(d);
  }

  const wosByName = new Map<string, CleanWorkOrder[]>();
  for (const w of wos) {
    const k = norm(w.dealNameMasked);
    if (!k) continue;
    (wosByName.get(k) ?? wosByName.set(k, []).get(k)!).push(w);
  }

  const matched: CrossBoardRow[] = [];
  for (const [name, ds] of dealsByName) {
    const ws = wosByName.get(name);
    if (!ws) continue;

    const dealSectors = [...new Set(ds.map((d) => d.sector).filter(Boolean))] as string[];
    const woSectors = [...new Set(ws.map((w) => w.sector).filter(Boolean))] as string[];
    const dealValues = ds.map((d) => d.dealValue).filter((v): v is number => v !== null);

    matched.push({
      dealName: ds[0].dealName ?? name,
      dealCount: ds.length,
      workOrderCount: ws.length,
      dealSectors,
      woSectors,
      dealValueKnown: dealValues.length ? round2(dealValues.reduce((a, b) => a + b, 0)) : null,
      woContractValue: round2(ws.reduce((a, w) => a + (w.amountExclGst ?? 0), 0)),
      woBilled: round2(ws.reduce((a, w) => a + (w.billedExclGst ?? 0), 0)),
      woReceivable: round2(ws.reduce((a, w) => a + (w.amountReceivable ?? 0), 0)),
      sectorConflict:
        dealSectors.length > 0 &&
        woSectors.length > 0 &&
        !dealSectors.some((s) => woSectors.includes(s)),
    });
  }

  matched.sort((a, b) => b.woContractValue - a.woContractValue);

  const matchedNames = new Set(matched.map((m) => norm(m.dealName)!));

  return {
    matched,
    dealsOnly: [...dealsByName.keys()].filter((k) => !matchedNames.has(k)).length,
    workOrdersOnly: [...wosByName.keys()].filter((k) => !matchedNames.has(k)).length,
    matchedDealNames: matched.length,
    totalDealNames: dealsByName.size,
    totalWoNames: wosByName.size,
    caveat:
      'Joined on masked deal name, the only field shared by the two boards. Deal names repeat across rows, so this join is many-to-many and indicative rather than a reliable record-level link. Do not treat matched totals as exact.',
  };
}

// ─── Pipeline health & risk ───────────────────────────────────────────────────

export interface RiskItem {
  kind: string;
  reference: string;
  detail: string;
  amount: number | null;
  severity: 'high' | 'medium' | 'low';
}

/**
 * Surfaces operational and commercial risk across both boards.
 * Rules are explicit and auditable rather than model-invented.
 */
export function findRisks(dataset: Dataset, asOf: string = today()): RiskItem[] {
  const risks: RiskItem[] = [];

  for (const w of dataset.workOrders) {
    const ref = w.serialNumber ?? w.dealNameMasked ?? w.id;

    if (w.executionStatus === 'Paused/Stuck') {
      risks.push({
        kind: 'Execution stalled',
        reference: ref,
        detail: `${w.dealNameMasked ?? 'Unnamed'} (${w.sector ?? 'no sector'}) is paused/stuck.`,
        amount: w.amountExclGst,
        severity: 'high',
      });
    }

    if (
      w.probableEndDate &&
      w.probableEndDate < asOf &&
      w.executionStatus &&
      IN_FLIGHT_EXECUTION_STATUSES.has(w.executionStatus)
    ) {
      risks.push({
        kind: 'Overdue delivery',
        reference: ref,
        detail: `Probable end date ${w.probableEndDate} has passed but status is still "${w.executionStatus}".`,
        amount: w.amountExclGst,
        severity: 'high',
      });
    }

    if (w.invoiceStatus === 'Stuck' || w.billingStatus === 'Stuck') {
      risks.push({
        kind: 'Billing stuck',
        reference: ref,
        detail: `Invoice status "${w.invoiceStatus ?? '—'}", billing status "${w.billingStatus ?? '—'}".`,
        amount: w.amountToBeBilledExcl,
        severity: 'high',
      });
    }

    if (
      w.executionStatus === 'Completed' &&
      w.amountToBeBilledExcl !== null &&
      w.amountToBeBilledExcl > 0
    ) {
      risks.push({
        kind: 'Delivered but unbilled',
        reference: ref,
        detail: `Work is complete with ${formatINR(w.amountToBeBilledExcl)} still to bill.`,
        amount: w.amountToBeBilledExcl,
        severity: 'high',
      });
    }

    if (w.arPriority && (w.amountReceivable ?? 0) > 0) {
      risks.push({
        kind: 'Priority receivable',
        reference: ref,
        detail: `Flagged AR priority with ${formatINR(w.amountReceivable)} outstanding.`,
        amount: w.amountReceivable,
        severity: 'high',
      });
    }

    if (w.billingStatus === 'Update Required') {
      risks.push({
        kind: 'Billing data incomplete',
        reference: ref,
        detail: 'Billing status is "Update Required" — finance cannot action this row as it stands.',
        amount: w.amountToBeBilledExcl,
        severity: 'medium',
      });
    }
  }

  for (const d of dataset.deals) {
    if (d.dealStatus !== 'Open') continue;
    const ref = d.dealName ?? d.id;

    if (d.tentativeCloseDate && d.tentativeCloseDate < asOf) {
      risks.push({
        kind: 'Stale open deal',
        reference: ref,
        detail: `Still Open but tentative close date ${d.tentativeCloseDate} has already passed.`,
        amount: d.dealValue,
        severity: 'medium',
      });
    }
    if (!d.tentativeCloseDate) {
      risks.push({
        kind: 'Unforecastable deal',
        reference: ref,
        detail: 'Open deal with no tentative close date — cannot be placed in any quarter.',
        amount: d.dealValue,
        severity: 'low',
      });
    }
    if (d.dealValue === null) {
      risks.push({
        kind: 'Unvalued deal',
        reference: ref,
        detail: 'Open deal with no value — contributes nothing to pipeline totals.',
        amount: null,
        severity: 'low',
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return risks.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || (b.amount ?? 0) - (a.amount ?? 0)
  );
}

// ─── Data quality report ──────────────────────────────────────────────────────

function fieldCoverage<T>(rows: T[], field: keyof T): { populated: number; total: number; pct: number } {
  const populated = rows.filter((r) => r[field] !== null && r[field] !== undefined).length;
  return {
    populated,
    total: rows.length,
    pct: rows.length ? Math.round((populated / rows.length) * 1000) / 10 : 0,
  };
}

export function dataQualityReport(dataset: Dataset) {
  const { deals, workOrders } = dataset;

  const dealDates = deals
    .map((d) => d.tentativeCloseDate)
    .filter((x): x is string => !!x)
    .sort();
  const woDates = workOrders.map((w) => w.poDate).filter((x): x is string => !!x).sort();

  const wonDeals = deals.filter((d) => d.dealStatus === 'Won');
  const openDeals = deals.filter((d) => d.dealStatus === 'Open');
  const staleStage = deals.filter((d) =>
    d.dataQualityIssues.some((i) => i.includes('stage field looks stale'))
  );

  const issueCounts = new Map<string, number>();
  for (const row of [...deals, ...workOrders]) {
    for (const issue of row.dataQualityIssues) {
      // Collapse per-row specifics into issue families.
      const family = issue.replace(/"[^"]*"/g, '"…"').replace(/\d{4}-\d{2}-\d{2}/g, 'a date');
      issueCounts.set(family, (issueCounts.get(family) ?? 0) + 1);
    }
  }

  return {
    source: dataset.source,
    fetchedAt: dataset.fetchedAt,
    rowCounts: {
      deals: deals.length,
      workOrders: workOrders.length,
      droppedDuringCleaning: dataset.droppedRows,
    },
    dataCoverageWindow: {
      dealTentativeCloseDates: dealDates.length
        ? { earliest: dealDates[0], latest: dealDates[dealDates.length - 1], populated: dealDates.length }
        : null,
      workOrderPoDates: woDates.length
        ? { earliest: woDates[0], latest: woDates[woDates.length - 1], populated: woDates.length }
        : null,
      note: 'Questions about periods outside these windows will legitimately return nothing.',
    },
    keyFieldCoverage: {
      deals: {
        dealValue: fieldCoverage(deals, 'dealValue'),
        tentativeCloseDate: fieldCoverage(deals, 'tentativeCloseDate'),
        closeDateActual: fieldCoverage(deals, 'closeDateActual'),
        closureProbability: fieldCoverage(deals, 'closureProbability'),
        sector: fieldCoverage(deals, 'sector'),
        ownerCode: fieldCoverage(deals, 'ownerCode'),
      },
      workOrders: {
        amountExclGst: fieldCoverage(workOrders, 'amountExclGst'),
        billedExclGst: fieldCoverage(workOrders, 'billedExclGst'),
        collectedAmount: fieldCoverage(workOrders, 'collectedAmount'),
        amountReceivable: fieldCoverage(workOrders, 'amountReceivable'),
        probableEndDate: fieldCoverage(workOrders, 'probableEndDate'),
        woStatusBilled: fieldCoverage(workOrders, 'woStatusBilled'),
      },
    },
    structuralIssues: {
      statusStageMismatch: {
        count: staleStage.length,
        note: 'Deals whose status is Won/Dead while the stage is still an early funnel stage. Use Deal Status for won/lost analysis; Deal Stage is only reliable for Open deals.',
      },
      wonDealsWithoutValue: {
        count: wonDeals.filter((d) => d.dealValue === null).length,
        of: wonDeals.length,
        note: 'Won revenue from the Deals board is a floor, not a total.',
      },
      openDealsWithoutValue: {
        count: openDeals.filter((d) => d.dealValue === null).length,
        of: openDeals.length,
      },
      alwaysEmptyWorkOrderColumns: [
        'Expected Billing Month',
        'Actual Collection Month',
        'Collection status',
        'Collection Date',
      ],
      quantityUnitsMixed:
        'Quantities as per PO mixes hectares, acres and bare numbers. Quantities are never summed across work orders.',
      schemaDrift: {
        missingColumns: dataset.missingColumns,
        unrecognisedColumns: dataset.unmappedColumns,
      },
    },
    topIssues: [...issueCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([issue, count]) => ({ issue, count })),
  };
}
