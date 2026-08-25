import { NextResponse } from 'next/server';
import { describeDataSourceError, getDataset, isMockMode } from '@/lib/data/source';
import { dataQualityReport } from '@/lib/query/engine';
import { getKeyPool } from '@/lib/agent/groq-pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Connection diagnostic. Hit this after configuring Monday.com to confirm the
 * token, both board IDs and the column mapping before opening the chat UI.
 */
export async function GET() {
  const env = {
    DATA_SOURCE: process.env.DATA_SOURCE ?? 'monday (default)',
    MONDAY_API_KEY: process.env.MONDAY_API_KEY ? 'set' : 'MISSING',
    MONDAY_DEALS_BOARD_ID: process.env.MONDAY_DEALS_BOARD_ID ? 'set' : 'MISSING',
    MONDAY_WORK_ORDERS_BOARD_ID: process.env.MONDAY_WORK_ORDERS_BOARD_ID ? 'set' : 'MISSING',
    GROQ_MODEL: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b (default)',
  };

  const keyPool = getKeyPool();
  const groq = {
    keysConfigured: keyPool.size,
    keys: keyPool.status(),
  };

  try {
    const dataset = await getDataset({ force: true });
    const report = dataQualityReport(dataset);

    return NextResponse.json({
      ok: true,
      mode: isMockMode() ? 'mock' : 'monday',
      env,
      groq,
      boards: {
        deals: { rows: dataset.deals.length, dropped: dataset.droppedRows.deals },
        workOrders: { rows: dataset.workOrders.length, dropped: dataset.droppedRows.workOrders },
      },
      columnMapping: {
        // Non-empty `missing` means the cleaner could not find a column it needs:
        // usually a renamed column during the Monday import.
        missing: dataset.missingColumns,
        unrecognised: dataset.unmappedColumns,
      },
      dataCoverageWindow: report.dataCoverageWindow,
      keyFieldCoverage: report.keyFieldCoverage,
    });
  } catch (err) {
    const { message, hint } = describeDataSourceError(err);
    return NextResponse.json(
      { ok: false, mode: isMockMode() ? 'mock' : 'monday', env, groq, error: message, hint },
      { status: 503 }
    );
  }
}
