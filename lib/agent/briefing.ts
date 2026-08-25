import type { Dataset } from '@/lib/monday/types';
import { formatINR } from '@/lib/cleaner/utils';
import {
  aggregateDeals,
  aggregateWorkOrders,
  crossBoardJoin,
  dataQualityReport,
  findRisks,
  listDeals,
  type AggregateResult,
} from '@/lib/query/engine';

/**
 * The leadership brief pack.
 *
 * A board update always answers the same questions, so the query set is fixed
 * in code rather than rediscovered by the model each time. Two reasons:
 * completeness — the model reliably under-calls tools and silently omits whole
 * sections — and comparability, since a brief whose shape drifts week to week
 * cannot be read as a trend.
 *
 * The model's job here is narration only. Everything below is computed.
 */

interface Line {
  label: string;
  count: number;
  value?: string;
  coverage?: string;
}

function lines(result: AggregateResult, currency: boolean, limit = 12): Line[] {
  return result.groups.slice(0, limit).map((g) => ({
    label: g.key,
    count: g.count,
    ...(currency && g.measure ? { value: formatINR(g.measure.sum) } : {}),
    ...(currency && g.measure && g.measure.coveragePct < 100
      ? { coverage: `${g.measure.countWithValue}/${g.measure.count} valued` }
      : {}),
  }));
}

function total(result: AggregateResult) {
  const m = result.total.measure;
  return {
    count: result.total.count,
    value: m ? formatINR(m.sum) : undefined,
    valued: m ? `${m.countWithValue}/${m.count}` : undefined,
    isFloor: m ? m.coveragePct < 100 : false,
  };
}

export function buildLeadershipPack(dataset: Dataset) {
  const { deals, workOrders } = dataset;

  const openFilter = { status: ['Open'] };

  const byStatus = aggregateDeals(deals, {}, 'count', 'dealStatus');
  const openByStage = aggregateDeals(deals, openFilter, 'dealValue', 'dealStage');
  const openBySector = aggregateDeals(deals, openFilter, 'dealValue', 'sector');
  const openTotal = aggregateDeals(deals, openFilter, 'dealValue');
  const wonTotal = aggregateDeals(deals, { status: ['Won'] }, 'dealValue');

  const woByStatus = aggregateWorkOrders(workOrders, {}, 'count', 'executionStatus');
  const woBySector = aggregateWorkOrders(workOrders, {}, 'contractValueExclGst', 'sector');

  const orderBook = aggregateWorkOrders(workOrders, {}, 'contractValueExclGst');
  const billed = aggregateWorkOrders(workOrders, {}, 'billedExclGst');
  const collected = aggregateWorkOrders(workOrders, {}, 'collectedInclGst');
  const receivable = aggregateWorkOrders(workOrders, {}, 'receivable');
  const toBill = aggregateWorkOrders(workOrders, {}, 'toBeBilledExclGst');
  const arPriority = aggregateWorkOrders(workOrders, { arPriorityOnly: true }, 'receivable');

  const topOpen = listDeals(deals, openFilter, { sortBy: 'dealValue', direction: 'desc', limit: 5 });

  const risks = findRisks(dataset);
  const riskByKind = new Map<string, { count: number; amount: number }>();
  for (const r of risks) {
    const cur = riskByKind.get(r.kind) ?? { count: 0, amount: 0 };
    riskByKind.set(r.kind, { count: cur.count + 1, amount: cur.amount + (r.amount ?? 0) });
  }

  const quality = dataQualityReport(dataset);
  const cross = crossBoardJoin(deals, workOrders);

  return {
    asOf: dataset.fetchedAt,
    source: dataset.source,

    pipeline: {
      dealsTotal: deals.length,
      byStatus: lines(byStatus, false),
      open: total(openTotal),
      openByStage: lines(openByStage, true),
      openBySector: lines(openBySector, true),
      largestOpenDeals: topOpen.rows.map((d) => ({
        name: d.dealName,
        sector: d.sector,
        stage: d.dealStage,
        value: d.dealValue === null ? 'not recorded' : formatINR(d.dealValue),
        close: d.tentativeCloseDate ?? 'no date',
        owner: d.ownerCode,
      })),
      wonValue: total(wonTotal),
    },

    execution: {
      workOrdersTotal: workOrders.length,
      byStatus: lines(woByStatus, false),
      inFlight: aggregateWorkOrders(workOrders, { inFlightOnly: true }, 'contractValueExclGst'),
    },

    money: {
      orderBookExclGst: total(orderBook),
      billedExclGst: total(billed),
      collectedInclGst: total(collected),
      receivable: total(receivable),
      yetToBillExclGst: total(toBill),
      arPriorityAccounts: total(arPriority),
      billedPctOfOrderBook:
        orderBook.total.measure && orderBook.total.measure.sum > 0
          ? `${Math.round(((billed.total.measure?.sum ?? 0) / orderBook.total.measure.sum) * 100)}%`
          : 'n/a',
    },

    sectors: {
      workOrderRevenue: lines(woBySector, true),
      openPipeline: lines(openBySector, true),
    },

    risks: {
      total: risks.length,
      byKind: [...riskByKind.entries()]
        .map(([kind, v]) => ({ kind, count: v.count, atStake: formatINR(v.amount) }))
        .sort((a, b) => b.count - a.count),
      topItems: risks.slice(0, 8).map((r) => ({
        kind: r.kind,
        ref: r.reference,
        detail: r.detail,
        amount: r.amount === null ? 'unknown' : formatINR(r.amount),
      })),
    },

    dataConfidence: {
      dealValueCoverage: quality.keyFieldCoverage.deals.dealValue,
      dealCloseDateCoverage: quality.keyFieldCoverage.deals.tentativeCloseDate,
      woAmountCoverage: quality.keyFieldCoverage.workOrders.amountExclGst,
      woBilledCoverage: quality.keyFieldCoverage.workOrders.billedExclGst,
      woCollectedCoverage: quality.keyFieldCoverage.workOrders.collectedAmount,
      statusStageMismatch: quality.structuralIssues.statusStageMismatch,
      wonDealsWithoutValue: quality.structuralIssues.wonDealsWithoutValue,
      alwaysEmptyColumns: quality.structuralIssues.alwaysEmptyWorkOrderColumns,
      dataCoverageWindow: quality.dataCoverageWindow,
      crossBoardMatches: cross.matchedDealNames,
      crossBoardCaveat: cross.caveat,
      rowsDroppedInCleaning: dataset.droppedRows,
    },
  };
}

/**
 * Detects a question that spans sales AND delivery.
 *
 * The model is told to query both boards for these and frequently does not, so
 * this drives a deterministic backstop rather than relying on the instruction.
 */
export function wantsBothBoards(message: string): boolean {
  return (
    /\bboth boards\b/i.test(message) ||
    /\bacross (both )?(the )?boards\b/i.test(message) ||
    /\b(compare|comparison|versus|vs\.?)\b/i.test(message) ||
    (/\bpipeline\b/i.test(message) && /\b(revenue|delivered|work ?orders?|billed|execution)\b/i.test(message)) ||
    // "What have we won but not yet invoiced?" starts on Deals and finishes on
    // Work Orders. Asked alone, the model answers the first half and says the
    // second cannot be quantified.
    (/\bwon\b/i.test(message) && BILLING_TERMS.test(message))
  );
}

const BILLING_TERMS =
  /\b(invoiced?|uninvoiced|unbilled|billed|billing|to bill|yet to bill|collect(ed|ion)?|receivable|outstanding|owed?)\b/i;

/**
 * Picks the work-order metric that actually answers the question when the
 * completeness backstop fills in the missing board. Defaults to contract value,
 * but an invoicing question wants the not-yet-invoiced figure instead.
 */
export function backstopWorkOrderMetric(message: string): string {
  if (/\b(not (yet )?(invoiced|billed)|uninvoiced|unbilled|yet to bill|to bill)\b/i.test(message)) {
    return 'toBeBilledExclGst';
  }
  if (/\b(receivable|outstanding|owed?|owes)\b/i.test(message)) return 'receivable';
  if (/\bcollect(ed|ion)?\b/i.test(message)) return 'collectedInclGst';
  if (/\b(invoiced?|billed|billing)\b/i.test(message)) return 'billedExclGst';
  return 'contractValueExclGst';
}

/**
 * Detects a request for the fixed-format leadership brief.
 *
 * Also catches the open-ended health check — "how are we doing?" — which is the
 * same question in plainer words. Left to choose its own queries the model
 * answered these from one unfiltered aggregate, folding ₹98 Cr of dead deals
 * into the pipeline and then claiming the billing data it never queried was
 * absent from the boards.
 */
export function isLeadershipBriefRequest(message: string): boolean {
  const overview =
    /^\s*(how (are|is|'?s) (we|things|it|business|the business)|how are we doing|how'?s it going)\b/i.test(
      message
    ) ||
    /\b(overall|overview|state of the business|business health|big picture|where do we stand|how healthy)\b/i.test(
      message
    );

  return overview
    || /\b(leadership|board)\s+(update|brief|meeting|summary|report)\b/i.test(message)
    || /\b(exec(utive)?\s+summary)\b/i.test(message)
    || /\b(brief|briefing)\b.*\b(leadership|board|exec)/i.test(message)
    || /\b(leadership|board|exec)\b.*\b(brief|briefing)\b/i.test(message)
    || /^\s*(give me|prepare|write|draft)\b.*\bbrief\b/i.test(message);
}
