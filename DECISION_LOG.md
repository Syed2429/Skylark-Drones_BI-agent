# Decision Log — Skylark Drones BI Agent

## 1. Key assumptions

**The agent must not do arithmetic.** The biggest correctness risk in an LLM BI tool is
a plausible wrong number. The model is given tools that compute in TypeScript and is
forbidden from calculating; every figure is traceable to a query shown in the UI.

**Deal Status is authoritative for won/lost; Deal Stage is not.** 97 deals marked Won or
Dead still sit at an early-funnel stage. The agent uses Status for outcomes, Stage only
for the shape of the *open* funnel, and reports the inconsistency when it matters.

**Missing is not zero.** No null is coerced. Every sum reports how many rows carried a
value, and partial totals are described as floors. With 52% of deal values absent, that
is the difference between an honest answer and a wrong one.

**Tentative Close Date is the timing field.** `Close Date (A)` is 7.6% populated, so it
cannot support "this quarter". The substitution is stated, not hidden.

**Unqualified quarters/years are Indian fiscal (Apr–Mar).** A bare `FYnn` reads by its
*ending* year per Indian convention; `FY25-26` states both ends. Every resolution
returns the range it used.

**"Energy" is a business word, not a data value.** Neither board has an Energy sector —
the assignment's own sample question asks for one. It expands to Renewables + Powerline
and the expansion is always disclosed. Likewise "infrastructure", "utilities".

**The cross-board join is indicative.** Masked deal name is the only shared field and
names repeat heavily (155 distinct across 344 rows), so the join is many-to-many by
construction. Every result carries that caveat.

## 2. Trade-offs

| Decision | Alternative | Why |
|---|---|---|
| **Tool-calling agent** | Pre-computed summary in the prompt | Prompt-stuffing makes the model do arithmetic (drift) and caps coverage at whatever the summary included. Costs ~1.5× the code and a few seconds of latency. Correctness is the product here. |
| **Monday GraphQL API** | MCP server | MCP returns raw rows, so the *model* would clean and total them — the exact failure mode designed out. It also needs a host process a serverless function cannot keep. |
| **Match columns by title** | Match by column ID | IDs are opaque and only knowable after the board exists, which would have blocked development. Mitigated by tolerant matching plus schema-drift reporting in `/api/health`. |
| **Groq `openai/gpt-oss-120b`** | GPT-4-class model | Free, fast, and selection is all it does. The spec named `llama-3.1-70b-versatile`; Groq has since retired the whole Llama family, so the model list is queried at runtime and errors name what is actually available. |
| **Multi-key pool with failover** | Single key | Free tier allows 8000 tokens/min per account and one conversation can spend most of it. Failing keys are benched for a cooldown matched to the limit hit. Keys from one account share a budget — so this only adds capacity across separate accounts. |
| **Fixed query bundle for the brief** | Let the model choose | The model reliably under-called tools and shipped briefs with sections unquantified. The ~15 queries are fixed in code; the model only narrates. Three round-trips become one, and briefs stay comparable week to week. |
| **Rule-based risk detection** | Ask the LLM to spot risks | "Overdue" and "stuck" must mean the same thing every time. Rules are auditable; the model narrates them rather than inventing them. |
| **Fetch per request, 60s cache** | Redis / longer TTL | Freshness is the point. The short TTL stops one turn re-paginating both boards and exhausting Monday's complexity budget. |
| **Custom markdown renderer** | `react-markdown` | Renders model output as React elements, never `dangerouslySetInnerHTML`. |

## 3. Constraints discovered while building

**Groq retired the model the spec named, then the whole family.** Rather than hardcode a
successor, the app queries Groq's model list on a model error and reports what actually
exists, so the message stays correct as the roster moves.

**8000 tokens/minute is the real budget — not latency or cost.** It counts across every
round *and* the `max_tokens` reserved for the reply; one verbose round consumed 7428 of
8000. That forced dense tool schemas, tool payloads capped at 6000 characters, and a
two-round ceiling.

**`gpt-oss` bills hidden reasoning against `max_tokens`.** At defaults, reasoning
consumed the budget and the reply came back empty. Fixed with `reasoning_effort: 'low'`
plus one retry at a larger budget. Separately, omitting `tools` makes Groq infer
`tool_choice: none` and a model that then calls a tool gets a hard 400 — so narration is
a separate call with no tool definitions in context at all.

**The model under-queries.** Asked to compare sectors "across both boards" it queried
one. Prompt rules did not fix it; a deterministic backstop does — if a question spans
both boards and only one was queried, the complementary query runs automatically and is
labelled as auto-added in the trace.

## 4. What I would do differently with more time

1. **Period comparison.** "Pipeline this quarter" is far more useful beside last quarter.
   The engine already resolves arbitrary periods; only a `compare_periods` tool is missing.
2. **Evaluation harness.** ~40 question/expected-tool-call pairs in CI. Computation
   correctness is guaranteed by construction; *selection* correctness currently rests on
   the prompt, and the under-querying above shows why that needs testing.
3. **Weighted pipeline.** With `Closure Probability` on 25% of deals, a weighted forecast
   today would be mostly fabricated — worth building once that field is filled.
4. **Fix the join key at source.** Recommend a shared deal ID across both boards. The
   cross-board caveat exists because of a modelling gap, not a code limitation.
5. **Write-back.** The agent can already name the 12 work orders whose billing status
   blocks finance; opening Monday updates on them closes the loop. Out of scope here —
   the brief specifies read-only.

## 5. How I interpreted "help prepare data for leadership updates"

I read it as: *the agent should produce the artefact, not hand over numbers for someone
else to assemble.* Asked for "something for the leadership meeting", a founder should get
a document.

So a brief request bypasses model tool-selection entirely and runs a fixed bundle across
both boards — pipeline by stage and sector, order book, billed, collected, receivable,
risks, and field coverage — then fills eight fixed sections: Executive Summary, Pipeline,
Execution, Revenue & Collections, Sector Performance, Risks, Recommended Actions, Data
Confidence.

Two choices are deliberate. **The structure is fixed, the content is not** — a brief that
changes shape week to week cannot be compared week to week. And **Data Confidence is
never omitted**: a leadership brief is exactly where a soft number becomes a hard
decision. Presenting ₹68.82 Cr of open pipeline without noting that 2 open deals carry no
value, and that 97 closed deals hold contradictory stage data, would be actively
misleading. That section is not a disclaimer — it tells leadership which fields to get
filled in, which is itself an actionable output.
