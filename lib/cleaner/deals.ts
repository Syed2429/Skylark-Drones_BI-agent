import type { CleanDeal, ClosureProbability, MondayItem } from '@/lib/monday/types';
import { cleanText, getCol, getNumberCol, isEmptyRow, normaliseTitle, parseISODate } from './utils';
import { ACTIVE_FUNNEL_STAGES, normaliseDealStatus, normaliseSector, parseDealStage } from './taxonomy';

/** Column titles as they appear in `Deal funnel Data.xlsx` → the Monday board. */
export const DEAL_COLUMNS = {
  OWNER: 'Owner code',
  CLIENT: 'Client Code',
  STATUS: 'Deal Status',
  CLOSE_DATE_ACTUAL: 'Close Date (A)',
  PROBABILITY: 'Closure Probability',
  VALUE: 'Masked Deal value',
  TENTATIVE_CLOSE: 'Tentative Close Date',
  STAGE: 'Deal Stage',
  PRODUCT: 'Product deal',
  SECTOR: 'Sector/service',
  CREATED: 'Created Date',
} as const;

/** Item-name column, which Monday promotes out of `column_values`. */
export const DEAL_NAME_COLUMN = 'Deal Name';

const ALL_DEAL_TITLES = [DEAL_NAME_COLUMN, ...Object.values(DEAL_COLUMNS)];

/**
 * The source spreadsheet has its header row repeated inside the data (rows 50
 * and 179). Rather than hardcode names, detect any row whose cells echo their
 * own column titles — that generalises to headers repeated anywhere.
 */
export function isRepeatedHeaderRow(item: MondayItem): boolean {
  if (normaliseTitle(item.name ?? '') === normaliseTitle(DEAL_NAME_COLUMN)) return true;

  let echoes = 0;
  for (const cv of item.column_values) {
    const text = cleanText(cv.text);
    if (text && normaliseTitle(text) === normaliseTitle(cv.title)) echoes += 1;
    if (echoes >= 3) return true;
  }
  return false;
}

const PROBABILITIES: ClosureProbability[] = ['High', 'Medium', 'Low'];

export function cleanDeal(item: MondayItem): CleanDeal {
  const cv = item.column_values;
  const issues: string[] = [];

  if (cleanText(item.name) === null) {
    issues.push('No deal name recorded');
  }

  const dealValue = getNumberCol(cv, DEAL_COLUMNS.VALUE);
  const sector = normaliseSector(getCol(cv, DEAL_COLUMNS.SECTOR));
  const dealStatusRaw = getCol(cv, DEAL_COLUMNS.STATUS);
  const dealStatus = normaliseDealStatus(dealStatusRaw);
  const stageRaw = getCol(cv, DEAL_COLUMNS.STAGE);
  const { letter, label } = parseDealStage(stageRaw);

  const probRaw = getCol(cv, DEAL_COLUMNS.PROBABILITY);
  const probMatch = PROBABILITIES.find((p) => p.toLowerCase() === probRaw?.toLowerCase());

  const tentativeCloseDate = parseISODate(getCol(cv, DEAL_COLUMNS.TENTATIVE_CLOSE));
  const closeDateActual = parseISODate(getCol(cv, DEAL_COLUMNS.CLOSE_DATE_ACTUAL));

  if (dealValue === null) issues.push('No deal value recorded');
  if (!sector) issues.push('No sector recorded');
  if (!dealStatus) {
    issues.push(
      dealStatusRaw
        ? `Unrecognised deal status "${dealStatusRaw}"`
        : 'No deal status recorded'
    );
  }
  if (!stageRaw) issues.push('No deal stage recorded');
  if (!tentativeCloseDate && dealStatus === 'Open') {
    issues.push('Open deal with no tentative close date — cannot be attributed to a quarter');
  }

  // Known systemic defect: status says Won while the stage is still early-funnel.
  if (dealStatus === 'Won' && stageRaw && ACTIVE_FUNNEL_STAGES.has(stageRaw)) {
    issues.push(`Status is "Won" but stage is still "${stageRaw}" — stage field looks stale`);
  }
  if (dealStatus === 'Dead' && stageRaw && ACTIVE_FUNNEL_STAGES.has(stageRaw)) {
    issues.push(`Status is "Dead" but stage is still "${stageRaw}" — stage field looks stale`);
  }
  if (dealStatus === 'Won' && dealValue === null) {
    issues.push('Won deal with no value — excluded from won-revenue totals');
  }

  return {
    id: item.id,
    dealName: cleanText(item.name),
    ownerCode: getCol(cv, DEAL_COLUMNS.OWNER),
    clientCode: getCol(cv, DEAL_COLUMNS.CLIENT),
    dealStatus,
    closeDateActual,
    closureProbability: probMatch ?? null,
    dealValue,
    tentativeCloseDate,
    dealStage: stageRaw,
    dealStageLetter: letter,
    dealStageLabel: label,
    productDeal: getCol(cv, DEAL_COLUMNS.PRODUCT),
    sector,
    createdDate: parseISODate(getCol(cv, DEAL_COLUMNS.CREATED)),
    dataQualityIssues: issues,
  };
}

export function cleanDeals(items: MondayItem[]): { deals: CleanDeal[]; dropped: number } {
  // Repeated header rows are genuine junk and go. Rows missing only their name
  // are kept — they still carry status, value and sector — and flagged instead.
  const kept = items.filter(
    (item) => !isRepeatedHeaderRow(item) && !isEmptyRow(item.name, item.column_values)
  );
  return { deals: kept.map(cleanDeal), dropped: items.length - kept.length };
}

/** Board column titles the cleaner knows about, for schema drift reporting. */
export function expectedDealTitles(): string[] {
  return ALL_DEAL_TITLES;
}
