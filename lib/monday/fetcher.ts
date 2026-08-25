import { mondayQuery, MondayApiError } from './client';
import { GET_BOARD_ITEMS_PAGE, GET_BOARD_META } from './queries';
import type { MondayBoardMeta, MondayItem } from './types';

const PAGE_SIZE = 100;
const MAX_PAGES = 60; // hard stop: 6000 items, well above either board

interface RawColumnValue {
  id: string;
  type: string;
  text: string | null;
  value: string | null;
  column?: { title?: string | null } | null;
}

interface RawItemsPageResponse {
  boards: Array<{
    id: string;
    name: string;
    items_page: {
      cursor: string | null;
      items: Array<{ id: string; name: string; column_values: RawColumnValue[] }>;
    };
  }> | null;
}

/** Flattens `column_values[].column.title` up onto the column value itself. */
function flattenItem(raw: {
  id: string;
  name: string;
  column_values: RawColumnValue[];
}): MondayItem {
  return {
    id: raw.id,
    name: raw.name,
    column_values: (raw.column_values ?? []).map((cv) => ({
      id: cv.id,
      title: cv.column?.title ?? cv.id,
      type: cv.type,
      text: cv.text,
      value: cv.value,
    })),
  };
}

export async function fetchBoardMeta(boardId: string): Promise<MondayBoardMeta> {
  const data = await mondayQuery<{ boards: MondayBoardMeta[] | null }>(GET_BOARD_META, {
    boardId,
  });
  const board = data.boards?.[0];
  if (!board) {
    throw new MondayApiError(
      `Board ${boardId} was not found.`,
      undefined,
      'Verify the board ID from the board URL (monday.com/boards/<BOARD_ID>) and that your token has read access to it.'
    );
  }
  return board;
}

export async function fetchAllItems(boardId: string): Promise<MondayItem[]> {
  const all: MondayItem[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const data: RawItemsPageResponse = await mondayQuery<RawItemsPageResponse>(
      GET_BOARD_ITEMS_PAGE,
      { boardId, limit: PAGE_SIZE, cursor }
    );

    const board = data.boards?.[0];
    if (!board) {
      throw new MondayApiError(
        `Board ${boardId} was not found.`,
        undefined,
        'Verify the board ID and that your token has read access to it.'
      );
    }

    all.push(...board.items_page.items.map(flattenItem));
    cursor = board.items_page.cursor;
    pages += 1;
  } while (cursor && pages < MAX_PAGES);

  return all;
}

export interface RawBoards {
  deals: MondayItem[];
  workOrders: MondayItem[];
  dealsMeta: MondayBoardMeta;
  workOrdersMeta: MondayBoardMeta;
}

export async function fetchBothBoards(): Promise<RawBoards> {
  const dealsId = process.env.MONDAY_DEALS_BOARD_ID;
  const woId = process.env.MONDAY_WORK_ORDERS_BOARD_ID;

  if (!dealsId) {
    throw new MondayApiError(
      'MONDAY_DEALS_BOARD_ID is not set',
      undefined,
      'Add the Deals board ID to .env.local, or set DATA_SOURCE=mock.'
    );
  }
  if (!woId) {
    throw new MondayApiError(
      'MONDAY_WORK_ORDERS_BOARD_ID is not set',
      undefined,
      'Add the Work Orders board ID to .env.local, or set DATA_SOURCE=mock.'
    );
  }

  const [dealsMeta, workOrdersMeta, deals, workOrders] = await Promise.all([
    fetchBoardMeta(dealsId),
    fetchBoardMeta(woId),
    fetchAllItems(dealsId),
    fetchAllItems(woId),
  ]);

  return { deals, workOrders, dealsMeta, workOrdersMeta };
}
