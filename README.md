# Skylark Drones — Monday.com BI Agent

Ask questions about your business in plain English. Get answers with real numbers,
pulled live from your Monday.com boards.

> **You ask:** "How's our pipeline looking for the energy sector this quarter?"
>
> **It answers:** with the deal count, the total value, and a chart — after working out
> that "energy" means Renewables + Powerline on your boards, that "this quarter" means
> the Indian fiscal quarter, and that 1 of those 12 deals has no value recorded, so the
> total is a floor rather than an exact figure.

No spreadsheets, no filters, no Monday.com views to configure. Just a chat box.

---

## Which part of this README do I need?

| You are… | Start at |
|---|---|
| Someone who wants to **use** the agent | [Using the agent](#using-the-agent) — no technical knowledge needed |
| Someone **setting it up** for the first time | [Setup](#setup) — about 20 minutes, most of it in Monday.com |
| A **developer** working on the code | [How it works](#how-it-works) and [For developers](#for-developers) |

---
---

# Using the agent

*This section assumes nothing technical. If someone has already set the agent up and
sent you a link, this is all you need.*

## What it knows about

The agent reads two boards from your Monday.com account, live, every time you ask:

- **Deals Pipeline** — every deal, its stage, status, owner, sector and value.
- **Work Orders** — every project you're delivering: what's been executed, invoiced,
  billed and collected.

It reads them **fresh on every question**, so the numbers always match what's on the
boards right now. It can only read — it will never change, move or delete anything.

## What you can ask

Type in plain English. You don't need field names, filters, or exact wording.

**Pipeline**
- How's our pipeline looking this quarter?
- What's the total value of our open deals?
- Which sectors have the most deals in play?
- Show me our biggest open deals in mining.

**Delivery and projects**
- What's our current order book?
- Which projects are stalled?
- How many work orders are still ongoing in renewables?

**Money**
- How much have we billed but not collected?
- What's our receivables position?
- Show me revenue by sector.

**Risk**
- What should I be worried about?
- Which deals have gone stale?
- Anything delivered that we haven't invoiced yet?

**The big one**
- Give me a leadership brief.

  This runs a fixed set of about 15 analyses across both boards and comes back with a
  full briefing — pipeline, delivery, billing, collections, risks — plus a six-chart
  dashboard. It takes longer than a normal question. It's built to be copy-pasted
  straight into an email or a board pack.

## How to read an answer

**The numbers are computed, not guessed.** The AI decides *what to look up* and writes
the sentences around it, but it never does the arithmetic itself. Every figure was
calculated from your actual rows.

**"How I worked this out"** — the expandable link under every answer. It shows, in plain
English, exactly which questions were asked of which board to produce the figure. If a
number ever looks wrong, open this first — it will usually show you a filter that means
something different from what you assumed.

**Charts** are built from the same numbers as the text above them, so they can never
disagree with the prose. Every chart has a one-click table view if you'd rather read the
raw figures.

## When the agent hedges — and why you should trust it more, not less

Your boards have real gaps in them. The agent is built to tell you about them instead of
papering over them.

| What you'll see | What it means |
|---|---|
| *"at least ₹9.50 Cr"* / *"this is a floor"* | Some deals in that group have no value recorded. It's summing what exists rather than treating blanks as zero. |
| *"47 of 49 deals have a value"* | Coverage. The total rests on 47 rows, not all 49. |
| *"using Tentative Close Date"* | The actual close date is filled in on very few rows, so date filters fall back to the tentative one. It always tells you when it does this. |
| *"energy isn't a sector on your boards — I've read it as Renewables + Powerline"* | You asked for something that doesn't literally exist as a value. It made a sensible expansion and told you what it did. |
| *"these two boards are matched on deal name, which isn't a reliable key"* | Cross-board answers join on masked deal name. Only 52 names appear on both boards. Treat it as indicative. |

A hedge is the agent being honest about your data, not being unsure of its own maths.

## What it can't do

- **It can't change anything.** Read-only, by design.
- **It doesn't remember previous conversations.** Each session starts clean.
- **It only knows those two boards.** Not email, not your CRM, not other Monday boards.
- **It won't invent numbers.** If the data can't answer your question, it says so.

## If something goes wrong

| What you see | What to do |
|---|---|
| "Rate limit" or the answer stalls | The free AI tier has a per-minute cap. Wait a minute and ask again. Whoever set this up can add more keys to raise the ceiling. |
| A number looks obviously wrong | Open **How I worked this out**. Nine times out of ten the filter meant something different from what you expected. |
| It says a column is missing | A column title on the Monday board was renamed. Tell whoever set it up — see [Troubleshooting](#troubleshooting). |
| Everything returns zero | The boards may be empty or the connection may have dropped. Setup owner should check `/api/health`. |

---
---

# Setup

Roughly 20 minutes. Most of it is importing two spreadsheets into Monday.com.

## Before you start

- **Node.js 18.17 or newer** — check with `node --version`. Download from
  [nodejs.org](https://nodejs.org) if you don't have it.
- **A Monday.com account** you can create boards in.
- **A Groq account** — free, no credit card, at [console.groq.com](https://console.groq.com).
- **Python 3** — only if you want to regenerate the Monday import CSVs yourself.

## Fast path: try it without Monday.com first

If you just want to see the agent working before touching Monday.com, you can run it
against a local fixture built from the two spreadsheets in this folder:

```bash
cd skylark-bi-agent
npm install
npm run seed                     # builds the fixture from the two .xlsx files
cp .env.example .env.local       # Windows: copy .env.example .env.local
```

Then edit `.env.local`:

```env
DATA_SOURCE=mock
GROQ_API_KEYS=gsk_your_key_here
```

```bash
npm run dev                      # → http://localhost:3000
```

The fixture is Monday-shaped and runs through the identical cleaning and query path, so
behaviour matches production — only the transport differs. This is for local development
before the boards exist; a real deployment should run `DATA_SOURCE=monday`.

> **Note:** nothing in the UI distinguishes fixture mode from live mode visually. Check
> `DATA_SOURCE` in your environment, or the `source` field in `/api/health`, if you're
> unsure which one you're looking at.

## Full setup

### 1. Install

```bash
cd skylark-bi-agent
npm install
```

### 2. Create the two Monday.com boards

> **Follow [MONDAY_SETUP.md](MONDAY_SETUP.md) for the click-by-click walkthrough with
> screenshots-level detail and troubleshooting.** The summary below is the reference.

Run this first — it writes import-ready CSVs to `../monday-import/`:

```bash
python scripts/make-import-csv.py
```

It fixes **only** what Monday's import wizard needs (blank leading row, date format,
currency rounding) and deliberately preserves every data-quality defect in the source.
Those defects are what the cleaning layer exists to handle — don't pre-clean them away.

**Board 1 — "Deals Pipeline"** from `Deal funnel Data.xlsx` (sheet `Deal tracker`).
Header is row 1; import normally.

| Column | Monday type |
|---|---|
| `Deal Name` | Item name (automatic) |
| `Owner code`, `Client Code`, `Product deal` | Text |
| `Deal Status` | Status — Won, Dead, Open, On Hold |
| `Deal Stage` | Status — all 16 stage values |
| `Closure Probability` | Status — High, Medium, Low |
| `Sector/service` | Dropdown — Renewables, Mining, Railways, Others, Powerline, Construction, DSP, Tender, Manufacturing, Security and Surveillance, Aviation |
| `Masked Deal value` | Numbers |
| `Close Date (A)`, `Tentative Close Date`, `Created Date` | Date |

**Board 2 — "Work Orders"** from `Work_Order_Tracker Data.xlsx` (sheet `work order tracker`).

> ⚠️ **Row 1 of this sheet is blank and row 2 is the real header.** Delete the blank
> first row before importing, or explicitly tell Monday's import wizard that row 2 is the
> header. Getting this wrong shifts every column. (The generated CSV already handles it.)

| Column | Monday type |
|---|---|
| `Deal name masked` | Item name (automatic) |
| `Execution Status` | Status — Completed, Ongoing, Not Started, Pause / struck, Partial Completed, Executed until current month, Details pending from Client |
| `Sector` | Dropdown — Mining, Renewables, Railways, Powerline, Others, Construction |
| `Nature of Work` | Dropdown — One time Project, Proof of Concept, Annual Rate Contract, Monthly Contract |
| `Document Type` | Dropdown — Purchase Order, Email Confirmation, LOA/LOI |
| `Invoice Status`, `Billing Status`, `WO Status (billed)` | Status |
| All `Amount…`, `Billed…`, `Collected…`, `Quantity…`, `Balance…` columns | Numbers |
| All `…Date` columns | Date |
| Everything else | Text |

Four columns are entirely empty in the source data and can be imported as Text:
`Expected Billing Month`, `Actual Collection Month`, `Collection status`, `Collection Date`.

**Column titles must be preserved exactly.** The cleaner maps by title, tolerating only
case, whitespace and punctuation drift. `/api/health` names any column it expected but
could not find.

### 3. Collect three credentials

| Credential | Where to get it |
|---|---|
| **Monday API token** | monday.com → your avatar → *Developers* → *My access tokens* → copy the API v2 token. Read scope is enough; the agent never writes. |
| **Board IDs** | The number in each board's URL: `monday.com/boards/<BOARD_ID>` |
| **Groq API key** | [console.groq.com](https://console.groq.com) — free, no card |

### 4. Configure

```bash
cp .env.example .env.local        # Windows: copy .env.example .env.local
```

```env
DATA_SOURCE=monday
MONDAY_API_KEY=eyJhbGciOi...
MONDAY_DEALS_BOARD_ID=1234567890
MONDAY_WORK_ORDERS_BOARD_ID=9876543210
GROQ_API_KEYS=gsk_...,gsk_...     # several keys = automatic failover
GROQ_MODEL=openai/gpt-oss-120b
```

**About `GROQ_API_KEYS`:** Groq's free tier allows 8000 tokens per minute **per account**,
which a single multi-round conversation can exhaust. Give it a comma-separated pool and a
rate-limited request retries on the next key automatically, benching the exhausted one for
a cooldown matched to what it hit (about a minute for a per-minute cap, an hour for a daily
one). Keys from the *same* account share one budget, so pooling only adds capacity if the
keys come from **different** accounts. A single `GROQ_API_KEY` also works and is treated as
a pool of one.

`.env.local` is gitignored. Never commit it.

### 5. Verify the connection before opening the UI

```bash
npm run dev
curl http://localhost:3000/api/health
```

A healthy response reports row counts for both boards (**344 deals, 176 work orders** for
the supplied data) and an empty `columnMapping.missing`. If a column title drifted during
import it will be named there — fix the title on the board and re-check.

### 6. Run

```bash
npm run dev                       # → http://localhost:3000
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/api/health` shows 0 rows | Wrong board ID, or the token lacks access to that board | Re-copy the ID from the board URL; confirm the token's account can see the board |
| `columnMapping.missing` lists columns | A column title was changed during import | Rename it on the Monday board to match the tables above, exactly |
| Work Orders columns all look shifted | The blank first row was imported as the header | Re-import using the generated CSV, or tell the wizard row 2 is the header |
| Deal count is 346, not 344 | Expected — the two repeated header rows are dropped by the cleaner, not by Monday | Nothing to fix |
| `401` / auth errors from Monday | Token expired or wrong type | Generate a fresh API **v2** token |
| Rate limit errors from Groq | Free-tier per-minute cap | Add more keys from **different** Groq accounts to `GROQ_API_KEYS` |
| Leadership brief times out locally | It runs ~15 queries over both boards | Expected to be slow; on Vercel `vercel.json` raises the limit to 60s |
| `npm install` fails | Node too old | Node 18.17+ required |

## Deploy to Vercel

```bash
npm i -g vercel
vercel

vercel env add MONDAY_API_KEY production
vercel env add MONDAY_DEALS_BOARD_ID production
vercel env add MONDAY_WORK_ORDERS_BOARD_ID production
vercel env add GROQ_API_KEYS production       # comma-separated pool
vercel env add GROQ_MODEL production          # openai/gpt-oss-120b

vercel --prod
```

`vercel.json` raises the `/api/chat` timeout to 60s — a leadership brief can run several
tool rounds over both boards.

The hosted prototype runs `DATA_SOURCE=monday` and queries the API on every request — no
spreadsheet data is embedded in the served application.

---
---

# How it works

The one-paragraph version, for anyone who wants to know why the numbers can be trusted:

**The AI decides what to look up and how to phrase the answer. It never does arithmetic.**
Every figure in an answer was computed in TypeScript over cleaned rows and handed back to
the model to narrate. That's why the numbers are checkable and why "How I worked this out"
can show you the exact queries behind them.

```
Browser ── chat UI (Next.js App Router, React)
   │
   │ POST /api/chat
   ▼
┌──────────────────────────────────────────────────────────────┐
│  Agent loop                          lib/agent/llm.ts        │
│                                                              │
│  Groq gpt-oss-120b decides WHICH tool to call and how to     │
│  narrate the result. It never computes anything.             │
└───────────────┬──────────────────────────────────────────────┘
                │ tool calls (parallel within a round)
                ▼
┌──────────────────────────────────────────────────────────────┐
│  Deterministic query engine          lib/query/engine.ts     │
│                                                              │
│  filter · aggregate · list · cross-board join · risk rules   │
│  · data-quality report. All arithmetic in TypeScript.        │
│  Every measure carries its own null-coverage stats.          │
└───────────────┬──────────────────────────────────────────────┘
                │ CleanDeal[] / CleanWorkOrder[]
                ▼
┌──────────────────────────────────────────────────────────────┐
│  Cleaning layer                      lib/cleaner/*           │
│                                                              │
│  repeated-header detection · date & number normalisation ·   │
│  sector/status/billing canonicalisation · per-row quality    │
│  flags · schema-drift detection                              │
└───────────────┬──────────────────────────────────────────────┘
                │ MondayItem[]
                ▼
┌──────────────────────────────────────────────────────────────┐
│  Data source (60s TTL cache)         lib/data/source.ts      │
│    · Monday.com GraphQL API v2 (default) — paginated         │
│    · local fixture (DATA_SOURCE=mock)  — dev only            │
└──────────────────────────────────────────────────────────────┘
```

The interface is written for a founder, not an operator: no jargon, no field names, no
mention of tools or queries. Answers can be copied straight out for an email or a board
pack.

### Charts

Answers carry charts — a KPI row for headline money figures, horizontal bars for any
breakdown, and a full six-chart dashboard for a leadership brief. Every chart is built in
TypeScript from the same computed figures the prose quotes (`lib/agent/charts.ts`), so a
visual can never disagree with the text above it. Bars whose totals rest on incomplete data
say so on hover, and every chart has a one-click table view.

### Why this rather than prompt-stuffing

The obvious approach — pre-compute a text summary, paste it into the prompt, let the model
reason over it — fails in two ways. The model does the arithmetic itself, so totals drift.
And it can only answer what the summary happened to include; anything else gets a confident
guess. Tool-calling removes both failure modes: coverage is whatever the filters express,
and the numbers are checkable.

---
---

# For developers

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 14 (App Router) | UI and API in one deployable; first-class on Vercel |
| LLM | Groq `openai/gpt-oss-120b` | Free tier without a card, fast, native tool-calling. Groq has retired the Llama families; this is the current strongest tool-calling model there |
| Monday.com | GraphQL API v2 (`2024-10`) | Works inside a serverless function; no MCP process to host |
| Styling | Tailwind CSS | No design-system overhead for a single-screen app |
| State | Stateless per request, 60s dataset cache | Board data changes; freshness beats persistence |

## Project layout

```
app/
  page.tsx                  chat UI
  api/chat/route.ts         agent endpoint
  api/health/route.ts       connection diagnostic
  api/query/route.ts        deterministic engine, no LLM
components/
  Markdown.tsx              renders agent output as React elements, never raw HTML
  ToolTrace.tsx             the audit trail panel
lib/
  monday/                   GraphQL client, queries, paginated fetcher, types
  cleaner/                  normalisation, taxonomy, per-board cleaners
  query/                    dates (Indian fiscal calendar), engine
  agent/                    tool schemas, system prompt, agent loop, charts
  data/                     source abstraction + cache, mock fixture
scripts/
  build-mock-data.mjs       xlsx → Monday-shaped fixture  (npm run seed)
  make-import-csv.py        xlsx → Monday-importable CSVs
```

## npm scripts

| Script | Does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run lint` | Next lint |
| `npm run seed` | Build `lib/data/mock-boards.json` from the two .xlsx files, for `DATA_SOURCE=mock` |

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATA_SOURCE` | no | `monday` | `monday` (live API) or `mock` (local fixture) |
| `MONDAY_API_KEY` | when `monday` | — | Monday API v2 token, read scope |
| `MONDAY_DEALS_BOARD_ID` | when `monday` | — | Deals board ID |
| `MONDAY_WORK_ORDERS_BOARD_ID` | when `monday` | — | Work Orders board ID |
| `GROQ_API_KEYS` | yes* | — | Comma-separated key pool with failover |
| `GROQ_API_KEY` | yes* | — | Single key; treated as a pool of one |
| `GROQ_MODEL` | no | `openai/gpt-oss-120b` | Groq model id |
| `DATA_CACHE_TTL_MS` | no | `60000` | How long a fetched dataset is reused across tool calls |

\* one of `GROQ_API_KEYS` or `GROQ_API_KEY`.

## HTTP API

| Endpoint | Purpose |
|---|---|
| `POST /api/chat` | `{ message, history[] }` → `{ answer, charts[], trace[], meta }` |
| `GET /api/health` | Connection, board row counts, column mapping, field coverage |
| `GET /api/query` | Lists the analysis tools and their JSON schemas |
| `POST /api/query` | `{ tool, args }` → raw structured result, bypassing the LLM |

`/api/query` runs the deterministic engine with the narration stripped off. It is how the
figures below were checked against the source spreadsheets:

```bash
curl -X POST localhost:3000/api/query -H 'Content-Type: application/json' -d '{
  "tool": "aggregate_deals",
  "args": { "filter": {"status":["Open"],"sector":["energy"]}, "metric": "dealValue" }
}'
```

## The analysis tools

| Tool | What it does |
|---|---|
| `describe_data` | Row counts, every distinct categorical value, date coverage windows, sector vocabulary |
| `leadership_pack` | Not model-selectable. A leadership-brief request runs a fixed bundle of ~15 queries across both boards in code, then makes a single narration call |
| `aggregate_deals` | Count or sum deal value, filtered and grouped, with null coverage |
| `aggregate_work_orders` | Count or sum any revenue metric, filtered and grouped |
| `list_deals` / `list_work_orders` | Individual records when named examples are wanted |
| `cross_board_view` | Join on masked deal name, with its reliability caveat attached |
| `find_risks` | Rule-based scan: stalled execution, overdue delivery, stuck billing, delivered-but-unbilled, priority receivables, stale deals |
| `data_quality_report` | Field completeness, structural defects, schema drift |

Two behaviours are enforced in code rather than left to the model, because testing showed
it got them wrong:

- **A leadership brief** runs a fixed bundle of ~15 queries across both boards, then makes
  a single narration call. Left to choose, the model under-queried and shipped briefs with
  whole sections unquantified.
- **A cross-board question** that only queried one board gets the complementary query run
  automatically, with the right metric inferred from the question. It is labelled as
  auto-added in the trace.

## How messy data is handled

Findings below come from profiling the actual files, not assumptions.

| Problem in the real data | Handling |
|---|---|
| Header row repeated at rows 50 and 179 of the Deals sheet — **carrying real deal names** (`Nezuko`, `Bugs Bunny`) while every other cell echoes its column title | Detected by counting cells that equal their own column title, not by matching the name. A name-based filter misses both rows. |
| Row 1 of the Work Orders sheet is entirely blank | Dropped as a nameless item |
| 52% of deals have no value | Never coerced to 0. Sums report `coveragePct`; the agent states totals are floors |
| 95 Won/Dead deals still sit at an early funnel stage | Flagged per row; the agent is instructed to use Deal Status, never stage, for won/lost |
| `Close Date (A)` populated on 7.6% of rows | Period filters default to `Tentative Close Date`; the substitution is stated in the answer |
| `Executed until current month` execution status | Kept distinct as `Ongoing (Recurring)` — a recurring contract is not the same as Completed |
| `BIlled` typo, plus `Billed- Visit 3` / `Billed- Visit 7` | Canonicalised to `Billed` |
| 4 always-empty Work Order columns | Excluded from schema-drift warnings, reported in the quality report |
| PO quantities mixing `5360 HA`, `2057 Acr`, `4` | Kept as raw text and never summed; unit ambiguity flagged per row |
| Negative receivables and end-before-start dates | Flagged per row rather than silently dropped |
| "Energy sector" — no such value on either board | Expands to Renewables + Powerline, and the expansion is reported to the user |
| A column renamed during Monday import | Title matching tolerates case/whitespace/punctuation; anything still unmatched surfaces in `/api/health` |

## Verification

Engine output was checked against an independent pandas analysis of the source files.
Exact agreement on:

| Figure | Value |
|---|---|
| Deals after cleaning | 344 (2 repeated header rows dropped) |
| Work orders after cleaning | 176 |
| Open deals | 49, ₹68.82 Cr known value, 47 of 49 valued |
| Open "energy" deals | 12, ₹3.19 Cr, 11 of 12 valued |
| Won deals | ₹9.50 Cr floor (101 of 165 carry no value) |
| Order book (excl GST) | ₹21.16 Cr, 175 of 176 valued |
| Billed / collected / receivable | ₹10.74 Cr / ₹9.04 Cr / ₹3.63 Cr |
| Work order revenue by sector | Renewables ₹9.35 Cr, Railways ₹5.99 Cr, Mining ₹4.82 Cr |
| Deal names on both boards | 52 |

Figures were cross-checked twice: against pandas over the source spreadsheets, and again
against the live monday.com boards after import.

## Related documents

| File | Contents |
|---|---|
| [MONDAY_SETUP.md](MONDAY_SETUP.md) | Click-by-click board import walkthrough with troubleshooting |
| [DECISION_LOG.md](DECISION_LOG.md) | Why each significant design decision was made |
