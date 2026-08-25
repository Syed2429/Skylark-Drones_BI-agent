import Groq from 'groq-sdk';
import type { ChatCompletionCreateParamsNonStreaming } from 'groq-sdk/resources/chat/completions';
import type { Dataset } from '@/lib/monday/types';
import { executeTool, TOOL_DEFINITIONS } from './tools';
import { getKeyPool, GroqPoolError, listAvailableModels } from './groq-pool';
import { buildCharts, type ChartSpec } from './charts';
import {
  backstopWorkOrderMetric,
  buildLeadershipPack,
  isLeadershipBriefRequest,
  wantsBothBoards,
} from './briefing';

/**
 * The agent loop.
 *
 * The model plans and narrates; every fact it can cite comes back from a tool
 * that computed it deterministically over the cleaned rows. We cap the number
 * of rounds so a confused model cannot loop forever inside a serverless
 * function's time budget.
 */

/**
 * Token budgeting.
 *
 * Groq's free tier caps a single account at 8000 tokens per MINUTE, counted
 * across every round of the conversation and including the `max_tokens` we
 * reserve for the reply. A chatty agent therefore rate-limits itself long
 * before it runs out of anything else, so the loop is kept short, the reply
 * budget is sized to the question, and tool payloads are capped hard.
 */
/** Rounds in which the model may call tools, before the narration pass. */
const MAX_TOOL_ROUNDS = 2;
const DEFAULT_MODEL = 'openai/gpt-oss-120b';

/** Roughly 4 chars per token; generous enough to keep a round under budget. */
const MAX_TOOL_PAYLOAD_CHARS = 6_000;

const REPLY_TOKENS_DEFAULT = 1_100;
/**
 * The brief renders eight sections and truncates below this. It is affordable
 * because a brief is a single model call — the query bundle runs in code — so
 * the whole request still lands well inside the per-minute budget.
 */
const REPLY_TOKENS_BRIEF = 3_000;
const REPLY_TOKENS_CEILING = 3_600;

/**
 * Long structured outputs need a bigger reply budget; ordinary answers do not.
 * Deliberately keyed off the SAME predicate that routes to the brief — when the
 * two disagreed, briefs were generated in full and then cut off mid-sentence.
 */
function replyTokenBudget(userMessage: string): number {
  return isLeadershipBriefRequest(userMessage) ? REPLY_TOKENS_BRIEF : REPLY_TOKENS_DEFAULT;
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCallTrace {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  /** Compact human-readable summary, shown in the UI's "how I got this" panel. */
  summary: string;
  durationMs: number;
}

export interface AgentResult {
  answer: string;
  /** Visuals built from the same computed figures the answer quotes. */
  charts: ChartSpec[];
  trace: ToolCallTrace[];
  rounds: number;
  model: string;
  /** Masked label of the API key that served the request. */
  keyUsed: string;
  /** Non-empty when the pool failed over mid-conversation. */
  keyRotations: string[];
}

type Msg = Groq.Chat.Completions.ChatCompletionMessageParam;

function summariseResult(name: string, result: Record<string, unknown>): string {
  if (result.ok === false) return `failed: ${result.error ?? 'unknown error'}`;

  switch (name) {
    case 'aggregate_deals':
    case 'aggregate_work_orders': {
      const total = result.total as { count: number; measure: { formatted?: string; coveragePct?: number } | null };
      const groups = (result.groups as unknown[] | undefined)?.length ?? 0;
      const value = total?.measure?.formatted ? `, ${total.measure.formatted}` : '';
      const cov =
        total?.measure && total.measure.coveragePct !== undefined && total.measure.coveragePct < 100
          ? ` (${total.measure.coveragePct}% value coverage)`
          : '';
      return `${total?.count ?? 0} records${value}${cov}${groups ? `, split ${groups} ways` : ''}`;
    }
    case 'list_deals':
    case 'list_work_orders':
      return `${result.returned} of ${result.totalMatching} matching records`;
    case 'cross_board_view':
      return `${result.matchedDealNames} deals matched to work orders`;
    case 'find_risks':
      return `${result.totalRisks} items flagged`;
    case 'describe_data':
      return `${(result.deals as { rowCount: number })?.rowCount} deals and ${(result.workOrders as { rowCount: number })?.rowCount} work orders on the boards`;
    case 'data_quality_report':
      return 'how complete each field is, and where the data disagrees with itself';
    default:
      return 'ok';
  }
}

/**
 * Truncates a tool payload that would otherwise blow the context window.
 * Row arrays are the only unbounded part, so we trim those and say we did.
 */
function capPayload(result: Record<string, unknown>): Record<string, unknown> {
  const MAX_CHARS = MAX_TOOL_PAYLOAD_CHARS;
  let json = JSON.stringify(result);
  if (json.length <= MAX_CHARS) return result;

  const copy = { ...result };
  if (Array.isArray(copy.rows)) {
    const rows = copy.rows as unknown[];
    let keep = rows.length;
    while (keep > 1 && json.length > MAX_CHARS) {
      keep = Math.floor(keep / 2);
      copy.rows = rows.slice(0, keep);
      copy.truncatedForContext = `Showing ${keep} of ${rows.length} rows; the counts and totals above cover all of them.`;
      json = JSON.stringify(copy);
    }
  }
  return copy;
}

/**
 * Last-resort answer built from the tool trace alone.
 *
 * Used when the model fails to produce prose after the data has already been
 * fetched. The figures are still the real computed ones, so the user gets
 * something true rather than an error page.
 */
function describeTraceFallback(trace: ToolCallTrace[]): string {
  const lines = trace
    .filter((t) => t.ok)
    .map((t) => `- \`${t.name}\` → ${t.summary}`)
    .join('\n');

  return [
    'I pulled the figures but could not finish writing them up. Here is what came back:',
    '',
    lines,
    '',
    'Please ask again — it usually works on a second try.',
  ].join('\n');
}

export async function runAgent(
  userMessage: string,
  history: ChatTurn[],
  dataset: Dataset,
  systemPrompt: string
): Promise<AgentResult> {
  const pool = getKeyPool();
  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;

  const messages: Msg[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((h) => ({ role: h.role, content: h.content }) as Msg),
    { role: 'user', content: userMessage },
  ];

  const maxReplyTokens = replyTokenBudget(userMessage);
  const trace: ToolCallTrace[] = [];
  const keyRotations: string[] = [];
  const gathered: Array<{ tool: string; args: Record<string, unknown>; result: unknown }> = [];
  let keyUsed = 'unknown';
  let rounds = 0;

  const onRotate = ({ from, kind, remaining }: { from: string; kind: string; remaining: number }) => {
    keyRotations.push(`${from} → ${kind} (${remaining} key(s) left)`);
  };

  const callModel = async (
    msgs: Msg[],
    withTools: boolean,
    tokenBudget: number = maxReplyTokens
  ): Promise<Groq.Chat.Completions.ChatCompletion> => {
    const params = {
      model,
      messages: msgs,
      ...(withTools ? { tools: [...TOOL_DEFINITIONS], tool_choice: 'auto' as const } : {}),
      temperature: 0.2,
      max_tokens: tokenBudget,
      stream: false as const,
      // gpt-oss emits hidden reasoning tokens that are billed against
      // max_tokens. Left at the default, reasoning can swallow the entire
      // budget and the reply comes back empty. The planning here is simple —
      // pick a tool, or narrate numbers already computed — so low suffices.
      // `reasoning_effort` is a Groq extension the SDK does not yet type.
      reasoning_effort: 'low',
    };

    const attempt = await pool.run(
      (client) =>
        client.chat.completions.create(
          params as unknown as ChatCompletionCreateParamsNonStreaming
        ),
      onRotate
    );
    keyUsed = attempt.keyLabel;
    return attempt.result;
  };

  const mapError = async (err: unknown): Promise<never> => {
    if (err instanceof GroqPoolError) throw new AgentError(err.message, err.hint);

    const message = err instanceof Error ? err.message : String(err);

    if (/model.*(decommission|not found|does not exist)/i.test(message)) {
      // Ask Groq what it actually serves rather than naming a replacement that
      // may itself have been retired since this was written.
      const available = await listAvailableModels(pool);
      throw new AgentError(
        `The configured model "${model}" is not available on Groq.`,
        available.length
          ? `Set GROQ_MODEL to one of: ${available.join(', ')}`
          : 'Set GROQ_MODEL to a current model. See console.groq.com/docs/models.'
      );
    }
    if (/context.*length|too many tokens|maximum context/i.test(message)) {
      throw new AgentError(
        'The conversation grew past the model context limit.',
        'Start a new conversation, or ask a narrower question.'
      );
    }
    throw new AgentError(`Groq request failed: ${message}`);
  };

  // ── Fast path: leadership brief ────────────────────────────────────────────
  //
  // A board update always answers the same questions, so the query set is fixed
  // in code. Letting the model choose reliably under-called the tools and
  // dropped whole sections; this also cuts three model round-trips to one.
  if (isLeadershipBriefRequest(userMessage)) {
    const started = Date.now();
    const pack = buildLeadershipPack(dataset);
    trace.push({
      name: 'leadership_pack',
      arguments: {},
      ok: true,
      summary: `${pack.pipeline.dealsTotal} deals, ${pack.execution.workOrdersTotal} work orders, ${pack.risks.total} risks, order book ${pack.money.orderBookExclGst.value}`,
      durationMs: Date.now() - started,
    });
    gathered.push({ tool: 'leadership_pack', args: {}, result: pack });
  }

  // ── Phase 1: tool rounds ───────────────────────────────────────────────────
  for (let round = 0; round < (gathered.length ? 0 : MAX_TOOL_ROUNDS); round += 1) {
    rounds += 1;

    let completion: Groq.Chat.Completions.ChatCompletion;
    try {
      completion = await callModel(messages, true);
    } catch (err) {
      return mapError(err);
    }

    const choice = completion.choices[0]?.message;
    if (!choice) throw new AgentError('Groq returned no completion.');

    const toolCalls = choice.tool_calls ?? [];

    // The model answered directly — no data needed, or it already has enough.
    if (!toolCalls.length) {
      const answer = (choice.content ?? '').trim();
      if (answer) {
        return { answer, charts: buildCharts(gathered), trace, rounds, model, keyUsed, keyRotations };
      }
      break;
    }

    messages.push(choice as Msg);

    // Tool calls within a round are independent — run them concurrently.
    const results = await Promise.all(
      toolCalls.map(async (call) => {
        const started = Date.now();
        let args: Record<string, unknown> = {};
        let result: Record<string, unknown>;

        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          result = {
            ok: false,
            error: `Could not parse arguments for ${call.function.name}. Retry with valid JSON.`,
          };
          trace.push({
            name: call.function.name,
            arguments: {},
            ok: false,
            summary: 'invalid arguments',
            durationMs: Date.now() - started,
          });
          return { call, result };
        }

        try {
          result = await executeTool(call.function.name, args, dataset);
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }

        trace.push({
          name: call.function.name,
          arguments: args,
          ok: result.ok !== false,
          summary: summariseResult(call.function.name, result),
          durationMs: Date.now() - started,
        });

        return { call, result };
      })
    );

    for (const { call, result } of results) {
      const capped = capPayload(result);
      gathered.push({ tool: call.function.name, args: JSON.parse(call.function.arguments || '{}'), result: capped });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(capped),
      } as Msg);
    }
  }

  // ── Completeness backstop ──────────────────────────────────────────────────
  //
  // "Compare Mining and Renewables across both boards" needs both boards, but
  // the model routinely queries only Deals and answers half the question. Rather
  // than keep escalating the prompt, fill the gap deterministically: reuse the
  // sector filter it already chose and run the matching query on the other board.
  if (wantsBothBoards(userMessage) && gathered.length) {
    const usedDeals = gathered.some((g) => g.tool.includes('deals'));
    const usedWorkOrders = gathered.some((g) => g.tool.includes('work_orders'));

    const sectors = gathered
      .map((g) => (g.args.filter as { sector?: string[] } | undefined)?.sector)
      .find((s): s is string[] => Array.isArray(s) && s.length > 0);

    const started = Date.now();

    if (usedDeals && !usedWorkOrders) {
      const args = {
        filter: sectors ? { sector: sectors } : {},
        metric: backstopWorkOrderMetric(userMessage),
        groupBy: 'sector',
      };
      const result = await executeTool('aggregate_work_orders', args, dataset);
      trace.push({
        name: 'aggregate_work_orders',
        arguments: { ...args, autoAdded: true },
        ok: result.ok !== false,
        summary: `${summariseResult('aggregate_work_orders', result)} (added automatically — the question spans both boards)`,
        durationMs: Date.now() - started,
      });
      gathered.push({ tool: 'aggregate_work_orders', args, result: capPayload(result) });
    } else if (usedWorkOrders && !usedDeals) {
      const args = {
        filter: sectors ? { sector: sectors, status: ['Open'] } : { status: ['Open'] },
        metric: 'dealValue',
        groupBy: 'sector',
      };
      const result = await executeTool('aggregate_deals', args, dataset);
      trace.push({
        name: 'aggregate_deals',
        arguments: { ...args, autoAdded: true },
        ok: result.ok !== false,
        summary: `${summariseResult('aggregate_deals', result)} (added automatically — the question spans both boards)`,
        durationMs: Date.now() - started,
      });
      gathered.push({ tool: 'aggregate_deals', args, result: capPayload(result) });
    }
  }

  // ── Phase 2: narration ─────────────────────────────────────────────────────
  //
  // A dedicated call with NO tool definitions in context. Keeping tools in
  // scope and merely asking the model not to use them fails: Groq infers
  // tool_choice:none, the model emits a tool call anyway, and the request 400s.
  // With nothing to call, there is nothing to get wrong.
  if (!gathered.length) {
    throw new AgentError(
      'The agent could not gather any data for that question.',
      'Try rephrasing, or ask something more specific.'
    );
  }

  const digest = gathered
    .map((g) => `### ${g.tool}(${JSON.stringify(g.args)})\n${JSON.stringify(g.result)}`)
    .join('\n\n');

  const narrationMessages: Msg[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        `Question: ${userMessage}`,
        '',
        'Results already computed for you (every figure here is exact — do not recalculate):',
        digest,
        '',
        'These results are the ONLY data you have. Do not cite a board, metric or',
        'period that is not represented above. If something was not queried, say you',
        'did not check it this time — never say the data does not exist. Both boards',
        'carry sector, billing, collection and receivable fields.',
        'Write the final answer now. Do not describe the queries or mention tools.',
      ].join('\n'),
    },
  ];

  rounds += 1;
  let answer = '';

  // Two attempts. gpt-oss bills hidden reasoning against max_tokens, so a long
  // brief can end with finish_reason "length" and no visible content at all.
  // The retry buys more room rather than throwing away data already fetched.
  const retryTokens = Math.min(Math.round(maxReplyTokens * 1.8), REPLY_TOKENS_CEILING);
  for (const attemptTokens of [maxReplyTokens, retryTokens]) {
    let completion: Groq.Chat.Completions.ChatCompletion;
    try {
      completion = await callModel(narrationMessages, false, attemptTokens);
    } catch (err) {
      if (trace.length) {
        return {
          answer: describeTraceFallback(trace),
          charts: buildCharts(gathered),
          trace,
          rounds,
          model,
          keyUsed,
          keyRotations,
        };
      }
      return mapError(err);
    }

    const choice = completion.choices[0];
    answer = (choice?.message?.content ?? '').trim();

    if (answer) break;

    console.warn(
      `[agent] empty narration (finish_reason=${choice?.finish_reason}, budget=${attemptTokens}); retrying`
    );
    rounds += 1;
  }

  return {
    answer: answer || describeTraceFallback(trace),
    charts: buildCharts(gathered),
    trace,
    rounds,
    model,
    keyUsed,
    keyRotations,
  };
}
