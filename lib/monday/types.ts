// ─── Raw Monday.com API shapes ────────────────────────────────────────────────

export interface MondayColumnValue {
  id: string;
  /** Monday returns the column title on the column_values.column sub-object. */
  title: string;
  type: string;
  text: string | null;
  value: string | null;
}

export interface MondayItem {
  id: string;
  name: string;
  column_values: MondayColumnValue[];
}

export interface MondayColumnDef {
  id: string;
  title: string;
  type: string;
}

export interface MondayBoardMeta {
  id: string;
  name: string;
  columns: MondayColumnDef[];
}

// ─── Cleaned domain shapes ────────────────────────────────────────────────────

export type DealStatus = 'Open' | 'Won' | 'Dead' | 'On Hold';
export type ClosureProbability = 'High' | 'Medium' | 'Low';

export interface CleanDeal {
  id: string;
  dealName: string | null;
  ownerCode: string | null;
  clientCode: string | null;
  dealStatus: DealStatus | null;
  closeDateActual: string | null;
  closureProbability: ClosureProbability | null;
  /** Rupees. null when the source cell was blank — never coerced to 0. */
  dealValue: number | null;
  /** Primary date field: `Close Date (A)` is 92% empty in the source data. */
  tentativeCloseDate: string | null;
  dealStage: string | null;
  /** "A".."O" extracted from the stage prefix, or null for unprefixed stages. */
  dealStageLetter: string | null;
  dealStageLabel: string | null;
  productDeal: string | null;
  sector: string | null;
  createdDate: string | null;
  dataQualityIssues: string[];
}

export interface CleanWorkOrder {
  id: string;
  dealNameMasked: string | null;
  customerCode: string | null;
  serialNumber: string | null;
  natureOfWork: string | null;
  executionStatus: string | null;
  dataDeliveryDate: string | null;
  poDate: string | null;
  documentType: string | null;
  probableStartDate: string | null;
  probableEndDate: string | null;
  bdPersonnelCode: string | null;
  sector: string | null;
  typeOfWork: string | null;
  skylarkSoftware: string | null;
  lastInvoiceDate: string | null;
  latestInvoiceNo: string | null;
  /** Primary revenue field (contract value excl GST). */
  amountExclGst: number | null;
  amountInclGst: number | null;
  billedExclGst: number | null;
  billedInclGst: number | null;
  collectedAmount: number | null;
  amountToBeBilledExcl: number | null;
  amountToBeBilledIncl: number | null;
  amountReceivable: number | null;
  arPriority: boolean;
  invoiceStatus: string | null;
  quantityByOps: number | null;
  /** Free text in the source: "5360 HA", "2057 Acr", "4". Kept verbatim. */
  quantityPerPoRaw: string | null;
  quantityBilled: number | null;
  balanceQuantity: number | null;
  actualBillingMonth: string | null;
  woStatusBilled: string | null;
  billingStatus: string | null;
  dataQualityIssues: string[];
}

export interface Dataset {
  deals: CleanDeal[];
  workOrders: CleanWorkOrder[];
  fetchedAt: string;
  source: 'monday' | 'mock';
  /** Column titles present on the board but not recognised by the cleaner. */
  unmappedColumns: { deals: string[]; workOrders: string[] };
  /** Column titles the cleaner expected but could not find on the board. */
  missingColumns: { deals: string[]; workOrders: string[] };
  droppedRows: { deals: number; workOrders: number };
}
