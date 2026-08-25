import type { Dataset } from '@/lib/monday/types';
import {
  CANONICAL_SECTORS,
  DEAL_STAGE_ORDER,
  SECTOR_GROUPS,
} from '@/lib/cleaner/taxonomy';
import {
  aggregateDeals,
  aggregateWorkOrders,
  crossBoardJoin,
  dataQualityReport,
  DEAL_GROUPABLE,
  findRisks,
  listDeals,
  listWorkOrders,
  WO_GROUPABLE,
  type DealFilter,
  type DealGroupBy,
  type DealMetric,
  type WoGroupBy,
  type WoMetric,
  type WorkOrderFilter,
} from '@/lib/query/engine';
import { fiscalQuarterOf, fiscalYearLabel, fiscalYearOf, resolvePeriod, today } from '@/lib/query/dates';
import { formatINR } from '@/lib/cleaner/utils';

/**
 * Tool definitions in OpenAI/Groq function-calling format.
 *
 * Design rule: the model chooses WHAT to measure; this module decides HOW.
 * No arithmetic is ever delegated to the model — every number it sees in a tool
 * result was computed in TypeScript over the cleaned rows, and arrives with the
 * coverage stats needed to caveat it honestly.
 */

/**
 * Schemas are deliberately terse. They are re-sent on every round of the agent
 * loop, and Groq's free tier allows only 8000 tokens per MINUTE across the whole
 * conversation — so every word here is paid for on each of the agent's turns.
 */

const DEAL_FILTER_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'array',
      items: { type: 'string', enum: ['Open', 'Won', 'Dead', 'On Hold'] },
      description: 'Reliable won/lost field. Prefer over stage.',
    },
    stage: {
      type: 'array',
      items: { type: 'string' },
      description: 'Exact stage, e.g. "E. Proposal/Commercials Sent". See describe_data for the list.',
    },
    activeFunnelOnly: { type: 'boolean', description: 'Only still-winnable stages.' },
    sector: {
      type: 'array',
      items: { type: 'string' },
      description: 'Accepts business words like "energy"; the expansion is reported back to you.',
    },
    owner: { type: 'array', items: { type: 'string' }, description: 'e.g. OWNER_001' },
    client: { type: 'array', items: { type: 'string' }, description: 'e.g. COMPANY089' },
    probability: { type: 'array', items: { type: 'string', enum: ['High', 'Medium', 'Low'] } },
    product: { type: 'array', items: { type: 'string' } },
    namePattern: { type: 'string' },
    minValue: { type: 'number' },
    maxValue: { type: 'number' },
    hasValue: { type: 'boolean' },
    dateField: {
      type: 'string',
      enum: ['tentativeCloseDate', 'createdDate', 'closeDateActual'],
      description: 'Default tentativeCloseDate.',
    },
    period: {
      type: 'string',
      description:
        '"this quarter", "last quarter", "Q3 FY26", "FY25-26", "March 2026", "last 90 days", "all time". Bare quarters/years are Indian fiscal.',
    },
  },
  additionalProperties: false,
} as const;

const WO_FILTER_SCHEMA = {
  type: 'object',
  properties: {
    executionStatus: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Completed | Ongoing | Ongoing (Recurring) | Not Started | Partially Completed | Paused/Stuck | Pending Client Input',
    },
    inFlightOnly: { type: 'boolean', description: 'Delivery still owed.' },
    sector: { type: 'array', items: { type: 'string' } },
    owner: { type: 'array', items: { type: 'string' }, description: 'BD/KAM code.' },
    customer: { type: 'array', items: { type: 'string' } },
    natureOfWork: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['One time Project', 'Proof of Concept', 'Annual Rate Contract', 'Monthly Contract'],
      },
    },
    invoiceStatus: { type: 'array', items: { type: 'string' } },
    billingStatus: { type: 'array', items: { type: 'string' } },
    woStatus: { type: 'array', items: { type: 'string', enum: ['Open', 'Closed'] } },
    typeOfWorkPattern: { type: 'string', description: 'e.g. "LiDAR", "Topography"' },
    namePattern: { type: 'string' },
    arPriorityOnly: { type: 'boolean' },
    hasReceivable: { type: 'boolean' },
    minAmount: { type: 'number' },
    maxAmount: { type: 'number' },
    dateField: {
      type: 'string',
      enum: ['poDate', 'probableStartDate', 'probableEndDate', 'lastInvoiceDate', 'dataDeliveryDate'],
      description: 'Default poDate.',
    },
    period: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'describe_data',
      description:
        'Row counts, all distinct categorical values, date coverage, sector vocabulary. Use when unsure what values exist.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'aggregate_deals',
      description:
        'Count deals or sum deal value, filtered and optionally grouped. Returns null-coverage with every total.',
      parameters: {
        type: 'object',
        properties: {
          filter: DEAL_FILTER_SCHEMA,
          metric: { type: 'string', enum: ['count', 'dealValue'] },
          groupBy: { type: 'string', enum: [...DEAL_GROUPABLE] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'aggregate_work_orders',
      description:
        'Count work orders or sum a revenue metric. contractValueExclGst = order book, billedExclGst = invoiced, collectedInclGst = cash received, receivable = outstanding, toBeBilledExclGst = not yet invoiced. All five exist — never tell the user a metric is unavailable.',
      parameters: {
        type: 'object',
        properties: {
          filter: WO_FILTER_SCHEMA,
          metric: {
            type: 'string',
            enum: [
              'count',
              'contractValueExclGst',
              'contractValueInclGst',
              'billedExclGst',
              'billedInclGst',
              'collectedInclGst',
              'receivable',
              'toBeBilledExclGst',
            ],
          },
          groupBy: { type: 'string', enum: [...WO_GROUPABLE] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_deals',
      description: 'Individual deal records. Use when named examples are wanted, not a total.',
      parameters: {
        type: 'object',
        properties: {
          filter: DEAL_FILTER_SCHEMA,
          sortBy: {
            type: 'string',
            enum: ['dealValue', 'tentativeCloseDate', 'createdDate', 'dealName'],
          },
          direction: { type: 'string', enum: ['asc', 'desc'] },
          limit: { type: 'number', description: 'Default 10, cap 50. Keep small.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_work_orders',
      description: 'Individual work order records.',
      parameters: {
        type: 'object',
        properties: {
          filter: WO_FILTER_SCHEMA,
          sortBy: {
            type: 'string',
            enum: [
              'amountExclGst',
              'billedExclGst',
              'amountReceivable',
              'amountToBeBilledExcl',
              'poDate',
              'probableEndDate',
            ],
          },
          direction: { type: 'string', enum: ['asc', 'desc'] },
          limit: { type: 'number', description: 'Default 10, cap 50. Keep small.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'cross_board_view',
      description:
        'Join Deals to Work Orders on masked deal name. Many-to-many and indicative; pass on the caveat it returns.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Default 10.' },
          sector: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_risks',
      description:
        'Rule-based risk scan covering stalled execution, overdue delivery, stuck billing, delivered-but-unbilled, priority receivables and stale deals. OMIT `kind` unless the user asks about exactly one of those categories — a question naming two or more problems ("stuck or running late") must return everything and be summarised.',
      parameters: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low', 'all'] },
          kind: { type: 'string' },
          limit: { type: 'number', description: 'Default 10.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'data_quality_report',
      description:
        'Field completeness, structural defects, schema drift, date coverage. Call before claiming anything about data reliability.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
] as const;

// ─── Execution ────────────────────────────────────────────────────────────────

export interface ToolResult {
  ok: boolean;
  [key: string]: unknown;
}

function distinct<T>(rows: T[], field: keyof T): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = (r[field] as unknown as string | null) ?? '(not set)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count }));
}

function describeData(dataset: Dataset): ToolResult {
  const now = today();
  const dealDates = dataset.deals.map((d) => d.tentativeCloseDate).filter(Boolean).sort() as string[];
  const woDates = dataset.workOrders.map((w) => w.poDate).filter(Boolean).sort() as string[];

  return {
    ok: true,
    today: now,
    currentFiscalPeriod: `Q${fiscalQuarterOf(now)} ${fiscalYearLabel(fiscalYearOf(now))}`,
    source: dataset.source,
    fetchedAt: dataset.fetchedAt,
    deals: {
      rowCount: dataset.deals.length,
      status: distinct(dataset.deals, 'dealStatus'),
      stage: distinct(dataset.deals, 'dealStage'),
      sector: distinct(dataset.deals, 'sector'),
      owner: distinct(dataset.deals, 'ownerCode'),
      probability: distinct(dataset.deals, 'closureProbability'),
      product: distinct(dataset.deals, 'productDeal'),
      tentativeCloseDateRange: dealDates.length
        ? { earliest: dealDates[0], latest: dealDates[dealDates.length - 1] }
        : null,
    },
    workOrders: {
      rowCount: dataset.workOrders.length,
      executionStatus: distinct(dataset.workOrders, 'executionStatus'),
      sector: distinct(dataset.workOrders, 'sector'),
      owner: distinct(dataset.workOrders, 'bdPersonnelCode'),
      natureOfWork: distinct(dataset.workOrders, 'natureOfWork'),
      invoiceStatus: distinct(dataset.workOrders, 'invoiceStatus'),
      billingStatus: distinct(dataset.workOrders, 'billingStatus'),
      woStatusBilled: distinct(dataset.workOrders, 'woStatusBilled'),
      skylarkSoftware: distinct(dataset.workOrders, 'skylarkSoftware'),
      poDateRange: woDates.length
        ? { earliest: woDates[0], latest: woDates[woDates.length - 1] }
        : null,
    },
    sectorVocabulary: {
      canonical: CANONICAL_SECTORS,
      businessTermsThatExpand: Object.fromEntries(
        Object.entries(SECTOR_GROUPS).map(([k, v]) => [k, v.sectors])
      ),
    },
    coverageWarning:
      'Periods outside the date ranges above will correctly return zero rows. Say so plainly rather than implying the business is empty.',
  };
}

/**
 * Explains a zero-row result.
 *
 * "No deals close this quarter" and "our data stops before this quarter" look
 * identical in a count of 0, but mean opposite things to a founder. Whenever a
 * period filter returns nothing, say which one it was — deterministically, so
 * the model cannot skip it and report an empty pipeline as a business problem.
 */
function explainEmpty(
  dataset: Dataset,
  board: 'deals' | 'workOrders',
  period: { start: string; end: string; label: string } | null
): string | null {
  if (!period) return null;

  const dates = (
    board === 'deals'
      ? dataset.deals.map((d) => d.tentativeCloseDate)
      : dataset.workOrders.map((w) => w.poDate)
  )
    .filter((d): d is string => !!d)
    .sort();

  if (!dates.length) return 'No dates are populated on this board at all.';

  const earliest = dates[0];
  const latest = dates[dates.length - 1];

  if (period.start > latest) {
    return `No rows because ${period.label} starts after the last date in the data (${latest}). This is a data coverage limit, NOT an empty pipeline — say so explicitly and offer the most recent period that does have data.`;
  }
  if (period.end < earliest) {
    return `No rows because ${period.label} ends before the first date in the data (${earliest}). This is a data coverage limit, not a business signal.`;
  }
  return `${period.label} falls inside the populated date range (${earliest} to ${latest}), so zero rows is a genuine business result, not a data gap.`;
}

function summariseMeasure(m: ReturnType<typeof aggregateDeals>['total']['measure']) {
  if (!m) return null;
  return {
    ...m,
    coverageWarning:
      m.coveragePct < 100
        ? `Only ${m.countWithValue} of ${m.count} rows had a value. This sum is a floor, not a total.`
        : null,
  };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  dataset: Dataset
): Promise<ToolResult> {
  switch (name) {
    case 'describe_data':
      return describeData(dataset);

    case 'data_quality_report':
      return { ok: true, ...dataQualityReport(dataset) };

    case 'aggregate_deals': {
      const filter = (args.filter ?? {}) as DealFilter;
      const result = aggregateDeals(
        dataset.deals,
        filter,
        (args.metric as DealMetric) ?? 'count',
        args.groupBy as DealGroupBy | undefined
      );
      return {
        ok: true,
        scope: result.scope,
        total: { count: result.total.count, measure: summariseMeasure(result.total.measure) },
        groups: result.groups.map((g) => ({
          key: g.key,
          count: g.count,
          measure: summariseMeasure(g.measure),
        })),
        interpretation: result.resolution.notes,
        periodResolved: result.resolution.period,
        unresolvedPeriod: result.resolution.unresolvedPeriod,
        unmatchedSectors: result.resolution.unmatchedSectors,
        droppedFilters: result.resolution.droppedFilters,
        unknownValues: result.resolution.unknownValues,
        emptyReason:
          result.total.count === 0
            ? explainEmpty(dataset, 'deals', result.resolution.period)
            : null,
      };
    }

    case 'aggregate_work_orders': {
      const filter = (args.filter ?? {}) as WorkOrderFilter;
      const result = aggregateWorkOrders(
        dataset.workOrders,
        filter,
        (args.metric as WoMetric) ?? 'count',
        args.groupBy as WoGroupBy | undefined
      );
      return {
        ok: true,
        scope: result.scope,
        total: { count: result.total.count, measure: summariseMeasure(result.total.measure) },
        groups: result.groups.map((g) => ({
          key: g.key,
          count: g.count,
          measure: summariseMeasure(g.measure),
        })),
        interpretation: result.resolution.notes,
        periodResolved: result.resolution.period,
        unresolvedPeriod: result.resolution.unresolvedPeriod,
        unmatchedSectors: result.resolution.unmatchedSectors,
        droppedFilters: result.resolution.droppedFilters,
        unknownValues: result.resolution.unknownValues,
        emptyReason:
          result.total.count === 0
            ? explainEmpty(dataset, 'workOrders', result.resolution.period)
            : null,
      };
    }

    case 'list_deals': {
      const limit = Math.min(Number(args.limit ?? 20) || 20, 50);
      const { rows, totalMatching, resolution } = listDeals(
        dataset.deals,
        (args.filter ?? {}) as DealFilter,
        {
          sortBy: args.sortBy as string | undefined,
          direction: args.direction as 'asc' | 'desc' | undefined,
          limit,
        }
      );
      return {
        ok: true,
        totalMatching,
        returned: rows.length,
        truncated: totalMatching > rows.length,
        rows: rows.map((d) => ({
          name: d.dealName,
          status: d.dealStatus,
          stage: d.dealStage,
          sector: d.sector,
          owner: d.ownerCode,
          client: d.clientCode,
          value: d.dealValue,
          valueFormatted: d.dealValue === null ? 'not recorded' : formatINR(d.dealValue),
          tentativeClose: d.tentativeCloseDate,
          probability: d.closureProbability,
          issues: d.dataQualityIssues,
        })),
        interpretation: resolution.notes,
        periodResolved: resolution.period,
        unresolvedPeriod: resolution.unresolvedPeriod,
        unmatchedSectors: resolution.unmatchedSectors,
        droppedFilters: resolution.droppedFilters,
        unknownValues: resolution.unknownValues,
      };
    }

    case 'list_work_orders': {
      const limit = Math.min(Number(args.limit ?? 20) || 20, 50);
      const { rows, totalMatching, resolution } = listWorkOrders(
        dataset.workOrders,
        (args.filter ?? {}) as WorkOrderFilter,
        {
          sortBy: args.sortBy as string | undefined,
          direction: args.direction as 'asc' | 'desc' | undefined,
          limit,
        }
      );
      return {
        ok: true,
        totalMatching,
        returned: rows.length,
        truncated: totalMatching > rows.length,
        rows: rows.map((w) => ({
          serial: w.serialNumber,
          dealName: w.dealNameMasked,
          customer: w.customerCode,
          sector: w.sector,
          executionStatus: w.executionStatus,
          typeOfWork: w.typeOfWork,
          owner: w.bdPersonnelCode,
          contractValueExclGst: w.amountExclGst,
          contractValueFormatted: w.amountExclGst === null ? 'not recorded' : formatINR(w.amountExclGst),
          billedExclGst: w.billedExclGst,
          receivable: w.amountReceivable,
          toBeBilledExclGst: w.amountToBeBilledExcl,
          invoiceStatus: w.invoiceStatus,
          billingStatus: w.billingStatus,
          poDate: w.poDate,
          probableEndDate: w.probableEndDate,
          arPriority: w.arPriority,
          issues: w.dataQualityIssues,
        })),
        interpretation: resolution.notes,
        periodResolved: resolution.period,
        unresolvedPeriod: resolution.unresolvedPeriod,
        unmatchedSectors: resolution.unmatchedSectors,
        droppedFilters: resolution.droppedFilters,
        unknownValues: resolution.unknownValues,
      };
    }

    case 'cross_board_view': {
      const limit = Math.min(Number(args.limit ?? 15) || 15, 50);
      const result = crossBoardJoin(dataset.deals, dataset.workOrders);
      const sectorFilter = (args.sector as string[] | undefined)?.map((s) => s.toLowerCase());
      const matched = sectorFilter?.length
        ? result.matched.filter((m) =>
            [...m.dealSectors, ...m.woSectors].some((s) => sectorFilter.includes(s.toLowerCase()))
          )
        : result.matched;

      return {
        ok: true,
        matchedDealNames: result.matchedDealNames,
        totalDistinctDealNames: result.totalDealNames,
        totalDistinctWorkOrderNames: result.totalWoNames,
        namesOnlyInDeals: result.dealsOnly,
        namesOnlyInWorkOrders: result.workOrdersOnly,
        returned: Math.min(matched.length, limit),
        rows: matched.slice(0, limit).map((m) => ({
          ...m,
          woContractValueFormatted: formatINR(m.woContractValue),
        })),
        caveat: result.caveat,
      };
    }

    case 'find_risks': {
      const limit = Math.min(Number(args.limit ?? 25) || 25, 60);
      const severity = (args.severity as string | undefined) ?? 'all';
      const kind = (args.kind as string | undefined)?.toLowerCase();

      const allRisks = findRisks(dataset);
      const availableKinds = [...new Set(allRisks.map((r) => r.kind))];

      let risks = allRisks;
      if (severity !== 'all') risks = risks.filter((r) => r.severity === severity);

      // A `kind` filter that matches nothing is the most dangerous failure this
      // tool has: it returns zero, and zero risks reads as "all clear". Match on
      // shared words rather than raw substring ("stalled execution" must find
      // "Execution stalled"), and if it still misses, say so and return
      // everything rather than implying there is nothing wrong.
      let kindMatchedNothing = false;
      if (kind) {
        const wanted = kind.split(/\W+/).filter((w) => w.length > 3);
        const matched = risks.filter((r) => {
          const k = r.kind.toLowerCase();
          return k.includes(kind) || wanted.some((w) => k.includes(w));
        });

        if (matched.length) {
          risks = matched;
        } else {
          kindMatchedNothing = true;
        }
      }

      const byKind = new Map<string, { count: number; amount: number }>();
      for (const r of risks) {
        const cur = byKind.get(r.kind) ?? { count: 0, amount: 0 };
        byKind.set(r.kind, { count: cur.count + 1, amount: cur.amount + (r.amount ?? 0) });
      }

      return {
        ok: true,
        totalRisks: risks.length,
        summaryByKind: [...byKind.entries()]
          .map(([k, v]) => ({ kind: k, count: v.count, amountAtStake: v.amount, amountFormatted: formatINR(v.amount) }))
          .sort((a, b) => b.amountAtStake - a.amountAtStake),
        returned: Math.min(risks.length, limit),
        rows: risks.slice(0, limit).map((r) => ({
          ...r,
          amountFormatted: r.amount === null ? 'unknown' : formatINR(r.amount),
        })),
        note: 'Amounts are the full value of the affected record, not a quantified loss.',
        availableKinds,
        kindFilterWarning: kindMatchedNothing
          ? `No risk category matches "${args.kind}", so the filter was IGNORED and all risks are returned. Do NOT report this as "nothing is at risk". The real categories are: ${availableKinds.join(', ')}.`
          : null,
      };
    }

    default:
      return { ok: false, error: `Unknown tool "${name}".` };
  }
}

/** Exposed for the API route's period pre-check. */
export { resolvePeriod };
