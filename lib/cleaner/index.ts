import type { Dataset, MondayBoardMeta, MondayItem } from '@/lib/monday/types';
import { cleanDeals, DEAL_NAME_COLUMN, expectedDealTitles } from './deals';
import { cleanWorkOrders, expectedWorkOrderTitles, WO_NAME_COLUMN } from './workorders';
import { normaliseTitle } from './utils';
import { ALWAYS_EMPTY_WO_COLUMNS } from './taxonomy';

/**
 * On import, monday.com promotes the spreadsheet's first column to the item
 * name and titles that column "Name" — it is not returned in `column_values`
 * at all. Comparing it against the expected titles therefore always reports a
 * false mismatch, so both sides of the diff exclude it.
 */
const NAME_COLUMN_TITLES = new Set(
  ['Name', 'Item Name', DEAL_NAME_COLUMN, WO_NAME_COLUMN].map(normaliseTitle)
);

/**
 * Compares the titles the cleaner expects against the titles actually present
 * on the board, so schema drift surfaces as a caveat instead of silent nulls.
 */
function diffSchema(
  boardTitles: string[],
  expected: string[]
): { unmapped: string[]; missing: string[] } {
  const isNameColumn = (t: string) => NAME_COLUMN_TITLES.has(normaliseTitle(t));

  const board = boardTitles.filter((t) => !isNameColumn(t));
  const want = expected.filter((t) => !isNameColumn(t));

  const boardSet = new Set(board.map(normaliseTitle));
  const expectedSet = new Set(want.map(normaliseTitle));

  return {
    missing: want.filter((t) => !boardSet.has(normaliseTitle(t))),
    unmapped: board.filter((t) => !expectedSet.has(normaliseTitle(t))),
  };
}

export interface BuildDatasetInput {
  rawDeals: MondayItem[];
  rawWorkOrders: MondayItem[];
  dealsMeta?: MondayBoardMeta | null;
  workOrdersMeta?: MondayBoardMeta | null;
  source: 'monday' | 'mock';
}

export function buildDataset({
  rawDeals,
  rawWorkOrders,
  dealsMeta,
  workOrdersMeta,
  source,
}: BuildDatasetInput): Dataset {
  const { deals, dropped: droppedDeals } = cleanDeals(rawDeals);
  const { workOrders, dropped: droppedWos } = cleanWorkOrders(rawWorkOrders);

  const dealTitles =
    dealsMeta?.columns.map((c) => c.title) ??
    Array.from(new Set(rawDeals.flatMap((i) => i.column_values.map((c) => c.title))));
  const woTitles =
    workOrdersMeta?.columns.map((c) => c.title) ??
    Array.from(new Set(rawWorkOrders.flatMap((i) => i.column_values.map((c) => c.title))));

  const dealDiff = diffSchema(dealTitles, expectedDealTitles());
  const woDiff = diffSchema(woTitles, expectedWorkOrderTitles());

  return {
    deals,
    workOrders,
    fetchedAt: new Date().toISOString(),
    source,
    unmappedColumns: {
      // Columns known to be entirely empty are expected noise, not drift.
      deals: dealDiff.unmapped,
      workOrders: woDiff.unmapped.filter(
        (t) => !ALWAYS_EMPTY_WO_COLUMNS.some((e) => normaliseTitle(e) === normaliseTitle(t))
      ),
    },
    missingColumns: { deals: dealDiff.missing, workOrders: woDiff.missing },
    droppedRows: { deals: droppedDeals, workOrders: droppedWos },
  };
}

export * from './utils';
export * from './taxonomy';
