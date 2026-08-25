import { buildDataset } from '@/lib/cleaner';
import { fetchBothBoards } from '@/lib/monday/fetcher';
import { MondayApiError } from '@/lib/monday/client';
import type { Dataset, MondayBoardMeta, MondayItem } from '@/lib/monday/types';

/**
 * Single entry point for board data. Everything above this line is
 * source-agnostic: the query engine and the agent never know whether the rows
 * came from Monday.com or the local fixture.
 */

const CACHE_TTL_MS = Number(process.env.DATA_CACHE_TTL_MS ?? 60_000);

let cache: { dataset: Dataset; at: number } | null = null;
let inFlight: Promise<Dataset> | null = null;

export function isMockMode(): boolean {
  return (process.env.DATA_SOURCE ?? 'monday').toLowerCase() === 'mock';
}

interface MockFixture {
  boards: Record<string, { meta: MondayBoardMeta; items: MondayItem[] }>;
}

async function loadMock(): Promise<Dataset> {
  // Read at runtime rather than `import`ing: the fixture is generated output,
  // not source, so it is not committed, and a static import would fail the
  // build whenever it is absent — even though the default path never uses it.
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const path = join(process.cwd(), 'lib', 'data', 'mock-boards.json');

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(
      'DATA_SOURCE=mock but lib/data/mock-boards.json is missing. ' +
        'Run `npm run seed` to generate it from the source spreadsheets, ' +
        'or set DATA_SOURCE=monday to use the live boards.'
    );
  }

  const fixture = JSON.parse(raw) as MockFixture;

  return buildDataset({
    rawDeals: fixture.boards.deals.items,
    rawWorkOrders: fixture.boards.workOrders.items,
    dealsMeta: fixture.boards.deals.meta,
    workOrdersMeta: fixture.boards.workOrders.meta,
    source: 'mock',
  });
}

async function loadMonday(): Promise<Dataset> {
  const { deals, workOrders, dealsMeta, workOrdersMeta } = await fetchBothBoards();
  return buildDataset({
    rawDeals: deals,
    rawWorkOrders: workOrders,
    dealsMeta,
    workOrdersMeta,
    source: 'monday',
  });
}

/**
 * Returns the cleaned dataset.
 *
 * A short TTL cache is deliberate: one conversational turn can trigger several
 * tool calls, and each would otherwise re-paginate both boards and burn through
 * Monday's per-minute complexity budget. Concurrent callers share one in-flight
 * fetch rather than stampeding.
 */
export async function getDataset(options?: { force?: boolean }): Promise<Dataset> {
  const now = Date.now();

  if (!options?.force && cache && now - cache.at < CACHE_TTL_MS) {
    return cache.dataset;
  }
  if (!options?.force && inFlight) return inFlight;

  const load = isMockMode() ? loadMock() : loadMonday();

  inFlight = load
    .then((dataset) => {
      cache = { dataset, at: Date.now() };
      return dataset;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export function describeDataSourceError(err: unknown): {
  message: string;
  hint: string;
} {
  if (err instanceof MondayApiError) {
    return {
      message: err.message,
      hint:
        err.hint ??
        'Verify MONDAY_API_KEY, MONDAY_DEALS_BOARD_ID and MONDAY_WORK_ORDERS_BOARD_ID.',
    };
  }
  return {
    message: err instanceof Error ? err.message : String(err),
    hint: 'Unexpected failure while loading board data.',
  };
}

/** Test/dev helper — clears the memo so the next call refetches. */
export function resetDatasetCache(): void {
  cache = null;
  inFlight = null;
}
