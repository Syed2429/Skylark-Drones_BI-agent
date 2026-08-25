import { NextResponse, type NextRequest } from 'next/server';
import { describeDataSourceError, getDataset } from '@/lib/data/source';
import { executeTool, TOOL_DEFINITIONS } from '@/lib/agent/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Runs a single analysis tool directly, bypassing the LLM.
 *
 * This is the deterministic core with the narration stripped off — useful for
 * verifying figures against the source spreadsheets, for debugging a suspicious
 * answer, and for any caller that wants structured numbers rather than prose.
 *
 *   GET  /api/query                          → available tools
 *   POST /api/query {"tool":"...","args":{}} → tool result
 */

export async function GET() {
  return NextResponse.json({
    tools: TOOL_DEFINITIONS.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })),
    usage: 'POST { "tool": "<name>", "args": { ... } }',
  });
}

export async function POST(request: NextRequest) {
  let body: { tool?: unknown; args?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const tool = typeof body.tool === 'string' ? body.tool : '';
  const known = TOOL_DEFINITIONS.map((t) => t.function.name);
  if (!known.includes(tool as (typeof known)[number])) {
    return NextResponse.json(
      { error: `Unknown tool "${tool}".`, available: known },
      { status: 400 }
    );
  }

  let dataset;
  try {
    dataset = await getDataset();
  } catch (err) {
    const { message, hint } = describeDataSourceError(err);
    return NextResponse.json({ error: message, hint }, { status: 503 });
  }

  try {
    const result = await executeTool(
      tool,
      (body.args ?? {}) as Record<string, unknown>,
      dataset
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
