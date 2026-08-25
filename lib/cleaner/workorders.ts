import type { CleanWorkOrder, MondayItem } from '@/lib/monday/types';
import { cleanText, getCol, getNumberCol, isEmptyRow, parseISODate, parseQuantity } from './utils';
import {
  normaliseBillingStatus,
  normaliseExecutionStatus,
  normaliseSector,
} from './taxonomy';

/** Column titles as they appear in `Work_Order_Tracker Data.xlsx`. */
export const WO_COLUMNS = {
  CUSTOMER: 'Customer Name Code',
  SERIAL: 'Serial #',
  NATURE: 'Nature of Work',
  LAST_RECURRING_MONTH: 'Last executed month of recurring project',
  EXEC_STATUS: 'Execution Status',
  DELIVERY_DATE: 'Data Delivery Date',
  PO_DATE: 'Date of PO/LOI',
  DOC_TYPE: 'Document Type',
  START_DATE: 'Probable Start Date',
  END_DATE: 'Probable End Date',
  BD_CODE: 'BD/KAM Personnel code',
  SECTOR: 'Sector',
  WORK_TYPE: 'Type of Work',
  SOFTWARE: 'Is any Skylark software platform part of the client deliverables in this deal?',
  LAST_INVOICE_DATE: 'Last invoice date',
  INVOICE_NO: 'latest invoice no.',
  AMOUNT_EXCL: 'Amount in Rupees (Excl of GST) (Masked)',
  AMOUNT_INCL: 'Amount in Rupees (Incl of GST) (Masked)',
  BILLED_EXCL: 'Billed Value in Rupees (Excl of GST.) (Masked)',
  BILLED_INCL: 'Billed Value in Rupees (Incl of GST.) (Masked)',
  COLLECTED: 'Collected Amount in Rupees (Incl of GST.) (Masked)',
  TO_BILL_EXCL: 'Amount to be billed in Rs. (Exl. of GST) (Masked)',
  TO_BILL_INCL: 'Amount to be billed in Rs. (Incl. of GST) (Masked)',
  RECEIVABLE: 'Amount Receivable (Masked)',
  AR_PRIORITY: 'AR Priority account',
  QTY_OPS: 'Quantity by Ops',
  QTY_PO: 'Quantities as per PO',
  QTY_BILLED: 'Quantity billed (till date)',
  QTY_BALANCE: 'Balance in quantity',
  INVOICE_STATUS: 'Invoice Status',
  BILLING_MONTH: 'Actual Billing Month',
  WO_STATUS: 'WO Status (billed)',
  BILLING_STATUS: 'Billing Status',
} as const;

export const WO_NAME_COLUMN = 'Deal name masked';

export function cleanWorkOrder(item: MondayItem): CleanWorkOrder {
  const cv = item.column_values;
  const issues: string[] = [];

  const amountExclGst = getNumberCol(cv, WO_COLUMNS.AMOUNT_EXCL);
  const billedExclGst = getNumberCol(cv, WO_COLUMNS.BILLED_EXCL);
  const amountReceivable = getNumberCol(cv, WO_COLUMNS.RECEIVABLE);
  const sector = normaliseSector(getCol(cv, WO_COLUMNS.SECTOR));
  const executionStatus = normaliseExecutionStatus(getCol(cv, WO_COLUMNS.EXEC_STATUS));

  const probableStartDate = parseISODate(getCol(cv, WO_COLUMNS.START_DATE));
  const probableEndDate = parseISODate(getCol(cv, WO_COLUMNS.END_DATE));
  const poDate = parseISODate(getCol(cv, WO_COLUMNS.PO_DATE));

  // PO quantities are free text with mixed units ("5360 HA", "2057 Acr", "4").
  // We parse only to flag unit ambiguity — the raw string is what we expose,
  // because hectares and acres must never be summed into one number.
  const qty = parseQuantity(getCol(cv, WO_COLUMNS.QTY_PO));
  if (qty.value !== null && qty.unit === null && getCol(cv, WO_COLUMNS.QTY_PO)) {
    issues.push('PO quantity has no unit — not comparable across work orders');
  }

  if (cleanText(item.name) === null) {
    issues.push('No deal name recorded — cannot be linked to the Deals board');
  }
  if (amountExclGst === null) issues.push('No contract value (excl GST) recorded');
  if (amountExclGst === 0) issues.push('Contract value recorded as zero');
  if (!sector) issues.push('No sector recorded');
  if (!executionStatus) issues.push('No execution status recorded');
  if (!poDate) issues.push('No PO/LOI date recorded');
  if (!probableStartDate) issues.push('No probable start date');
  if (!probableEndDate) issues.push('No probable end date — cannot assess schedule risk');

  if (probableStartDate && probableEndDate && probableEndDate < probableStartDate) {
    issues.push(`End date ${probableEndDate} precedes start date ${probableStartDate}`);
  }
  if (amountReceivable !== null && amountReceivable < 0) {
    issues.push('Negative receivable — likely an over-collection or credit note');
  }
  if (
    billedExclGst !== null &&
    amountExclGst !== null &&
    amountExclGst > 0 &&
    billedExclGst > amountExclGst * 1.01
  ) {
    issues.push('Billed value exceeds contract value');
  }

  return {
    id: item.id,
    dealNameMasked: cleanText(item.name),
    customerCode: getCol(cv, WO_COLUMNS.CUSTOMER),
    serialNumber: getCol(cv, WO_COLUMNS.SERIAL),
    natureOfWork: getCol(cv, WO_COLUMNS.NATURE),
    executionStatus,
    dataDeliveryDate: parseISODate(getCol(cv, WO_COLUMNS.DELIVERY_DATE)),
    poDate,
    documentType: getCol(cv, WO_COLUMNS.DOC_TYPE),
    probableStartDate,
    probableEndDate,
    bdPersonnelCode: getCol(cv, WO_COLUMNS.BD_CODE),
    sector,
    typeOfWork: getCol(cv, WO_COLUMNS.WORK_TYPE),
    skylarkSoftware: getCol(cv, WO_COLUMNS.SOFTWARE),
    lastInvoiceDate: parseISODate(getCol(cv, WO_COLUMNS.LAST_INVOICE_DATE)),
    latestInvoiceNo: getCol(cv, WO_COLUMNS.INVOICE_NO),
    amountExclGst,
    amountInclGst: getNumberCol(cv, WO_COLUMNS.AMOUNT_INCL),
    billedExclGst,
    billedInclGst: getNumberCol(cv, WO_COLUMNS.BILLED_INCL),
    collectedAmount: getNumberCol(cv, WO_COLUMNS.COLLECTED),
    amountToBeBilledExcl: getNumberCol(cv, WO_COLUMNS.TO_BILL_EXCL),
    amountToBeBilledIncl: getNumberCol(cv, WO_COLUMNS.TO_BILL_INCL),
    amountReceivable,
    arPriority: (getCol(cv, WO_COLUMNS.AR_PRIORITY) ?? '').toLowerCase() === 'priority',
    invoiceStatus: normaliseBillingStatus(getCol(cv, WO_COLUMNS.INVOICE_STATUS)),
    quantityByOps: getNumberCol(cv, WO_COLUMNS.QTY_OPS),
    quantityPerPoRaw: getCol(cv, WO_COLUMNS.QTY_PO),
    quantityBilled: getNumberCol(cv, WO_COLUMNS.QTY_BILLED),
    balanceQuantity: getNumberCol(cv, WO_COLUMNS.QTY_BALANCE),
    actualBillingMonth: getCol(cv, WO_COLUMNS.BILLING_MONTH),
    woStatusBilled: getCol(cv, WO_COLUMNS.WO_STATUS),
    billingStatus: normaliseBillingStatus(getCol(cv, WO_COLUMNS.BILLING_STATUS)),
    dataQualityIssues: issues,
  };
}

export function cleanWorkOrders(items: MondayItem[]): {
  workOrders: CleanWorkOrder[];
  dropped: number;
} {
  // Only fully-empty rows are dropped (the source file's blank first row).
  // A work order missing just its deal name is still a real work order.
  const kept = items.filter((item) => !isEmptyRow(item.name, item.column_values));
  return { workOrders: kept.map(cleanWorkOrder), dropped: items.length - kept.length };
}

export function expectedWorkOrderTitles(): string[] {
  return [WO_NAME_COLUMN, ...Object.values(WO_COLUMNS)];
}
