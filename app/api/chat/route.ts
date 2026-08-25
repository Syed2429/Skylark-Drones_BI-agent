import { NextResponse, type NextRequest } from 'next/server';
import { describeDataSourceError, getDataset, isMockMode } from '@/lib/data/source';
import { buildSystemPrompt } from '@/lib/agent/prompts';
import { AgentError, runAgent, type ChatTurn } from '@/lib/agent/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Conversation turns kept for context. Tool traces are never replayed. */
const HISTORY_TURNS = 8;

export async function POST(request: NextRequest) {
  let body: { message?: unknown; history?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return NextResponse.json({ error: 'A message is required.' }, { status: 400 });
  }
  if (message.length > 4000) {
    return NextResponse.json({ error: 'That message is too long.' }, { status: 400 });
  }

  const history: ChatTurn[] = Array.isArray(body.history)
    ? (body.history as unknown[])
        .filter(
          (t): t is ChatTurn =>
            !!t &&
            typeof t === 'object' &&
            'role' in t &&
            'content' in t &&
            ((t as ChatTurn).role === 'user' || (t as ChatTurn).role === 'assistant') &&
            typeof (t as ChatTurn).content === 'string'
        )
        .slice(-HISTORY_TURNS)
    : [];

  // 1. Load board data (Monday.com, or the local fixture in mock mode).
  let dataset;
  try {
    dataset = await getDataset();
  } catch (err) {
    const { message: m, hint } = describeDataSourceError(err);
    console.error('[data source]', err);
    return NextResponse.json(
      {
        error: 'Could not load board data from Monday.com.',
        details: m,
        hint,
      },
      { status: 503 }
    );
  }

  if (!dataset.deals.length && !dataset.workOrders.length) {
    return NextResponse.json(
      {
        error: 'Both boards came back empty.',
        details: 'Monday.com returned no items for either board ID.',
        hint: 'Check that the board IDs point at the imported boards and that the API token can read them.',
      },
      { status: 503 }
    );
  }

  // 2. Run the tool-calling agent over the cleaned dataset.
  try {
    const result = await runAgent(
      message,
      history,
      dataset,
      buildSystemPrompt(dataset.source)
    );

    return NextResponse.json({
      answer: result.answer,
      charts: result.charts,
      trace: result.trace,
      meta: {
        source: dataset.source,
        isMock: isMockMode(),
        fetchedAt: dataset.fetchedAt,
        deals: dataset.deals.length,
        workOrders: dataset.workOrders.length,
        rounds: result.rounds,
        model: result.model,
        schemaWarnings: [
          ...dataset.missingColumns.deals.map((c) => `Deals board is missing column "${c}"`),
          ...dataset.missingColumns.workOrders.map(
            (c) => `Work Orders board is missing column "${c}"`
          ),
        ],
      },
    });
  } catch (err) {
    console.error('[agent]', err);
    if (err instanceof AgentError) {
      return NextResponse.json(
        { error: err.message, hint: err.hint },
        { status: 503 }
      );
    }
    return NextResponse.json(
      {
        error: 'The agent hit an unexpected error.',
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
