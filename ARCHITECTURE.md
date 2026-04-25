# Redline — Architecture

AI agent that reviews fire-sprinkler plan sheets, verifies code citations against the correct edition of NFPA, flags errors, and outputs a redlined PDF.

**Status**: v1, internal-only (single tenant — our design firm). Demo on Vercel Hobby; production on Vercel Pro.

**Surfaces**: Web UI (Next.js), Slack bot, MCP server.

---

## 1. System diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Clients                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │  Web UI      │  │  Slack       │  │  MCP Client  │           │
│  │  (React/Next)│  │  (/qc-sheet) │  │  (Cursor/etc)│           │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘           │
└─────────┼─────────────────┼─────────────────┼───────────────────┘
          │                 │                 │
          │ POST /api/      │ POST /api/      │ POST /api/mcp
          │ projects/:id/   │ slack/events    │ (Streamable HTTP)
          │ review          │                 │
          ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  Next.js 15 App Router (API routes, Node runtime on Vercel)     │
│  ─ /api/projects/:id/review     starts the review workflow      │
│  ─ /api/slack/events            VercelReceiver + waitUntil      │
│  ─ /api/mcp/[transport]         @vercel/mcp-adapter             │
│  ─ /api/upload                  Vercel Blob signed upload       │
└────────────────────────┬────────────────────────────────────────┘
                         │ start("review-sheet", {...})
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Vercel Workflow ("use workflow")                               │
│  Each step = own function invocation = own 60s timeout          │
│                                                                 │
│   1. ingestPdf            ── splits PDF into per-page jobs      │
│   2. for each page:                                             │
│      a. extractNotes      ── DurableAgent / Gemini 3 Pro vision │
│      b. classifyNotes     ── Haiku 4.5 (cheap)                  │
│      c. for each citation note:                                 │
│         i.  lookupCitation        ── pgvector retrieval         │
│         ii. verifyCitationClaim   ── Opus 4.7 (source-grounded) │
│      d. checkSpelling             ── deterministic              │
│      e. suggestClarity            ── Haiku 4.5                  │
│      f. checkStandardsCompliance  ── house standards rules      │
│   3. writeFindings        ── Postgres                           │
│   4. renderRedlinedPdf    ── pdf-lib draws boxes/notes          │
│   5. uploadResult         ── Vercel Blob                        │
│   6. notifyClient         ── return URL / Slack post / MCP rsp  │
└────────────────────────┬────────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Vercel       │  │  Neon        │  │ Vercel Blob  │
│ AI Gateway   │  │  Postgres    │  │  (PDFs in &  │
│ (Gemini 3,   │  │  + pgvector  │  │   redlined   │
│  Opus 4.7,   │  │              │  │   PDFs out)  │
│  Haiku 4.5,  │  │              │  │              │
│  embedding-3)│  │              │  │              │
└──────────────┘  └──────────────┘  └──────────────┘
```

**Why Workflow**: each step gets its own function invocation, so a 50-page extract that takes 20 min total works fine on Hobby's 60s/invocation cap. Steps survive crashes, retry on transient failures, and resume from the last completed step.

**Why DurableAgent (`@workflow/ai`)**: turns each LLM call and each tool call inside the agent loop into its own durable step. A reviewer agent that does N tool calls is N short invocations, not one long one.

---

## 2. Agent tools (live inside DurableAgent)

| Tool | Model / impl | Purpose | Hallucination guard |
|---|---|---|---|
| `extractNotesFromSheet` | `google/gemini-3-pro-preview` | Vision: read every text annotation on a sheet, return `{text, bbox, sheet, type}` | Schema-validated; missing notes flagged for manual review, never invented |
| `classifyNote` | `anthropic/claude-haiku-4.5` | Tag each note: `citation | spec | dimension | general | header` | Structured output with zod enum |
| `lookupCitation` | code (pgvector) | Given a citation string and project edition, return top-K NFPA sections with full text | **Code, never model.** Edition-filtered at SQL level |
| `verifyCitationClaim` | `anthropic/claude-opus-4.7` | Given the note's claim and the retrieved section text, return `{verdict, evidence, suggestedFix}` | Receives source text inline; `tool_choice: "required"` on lookup; verdict requires quoted evidence |
| `checkSpelling` | code (typo-js + house glossary) | Spellcheck note text against a sprinkler-domain dictionary | Deterministic |
| `suggestClarity` | `anthropic/claude-haiku-4.5` | Optional: rewrite ambiguous notes — flagged as "suggestion," never auto-applied | Always advisory; user must accept |
| `checkStandardsCompliance` | code + Haiku | Run house QC rules (e.g., "every spec callout must reference NFPA edition") | Rules in Postgres, pure data |

The DurableAgent's system prompt enforces: *"Citations are retrieved by tools, never recalled. If a lookup returns no result, return verdict: `unknown` and stop. Never paraphrase NFPA text — quote it."*

---

## 3. Data model (Neon Postgres)

```sql
-- projects: one per design job
projects (
  id            uuid pk,
  name          text,
  ahj           text,                     -- authority having jurisdiction
  nfpa_edition  text,                     -- '2019' | '2022' (drives retrieval filter)
  created_at    timestamptz
)

-- project_documents: original PDFs uploaded for a project
project_documents (
  id            uuid pk,
  project_id    uuid fk -> projects,
  blob_url      text,                     -- Vercel Blob URL (original)
  redlined_url  text,                     -- Vercel Blob URL (after review)
  page_count    int,
  uploaded_at   timestamptz
)

-- code_editions: registry of NFPA editions we've ingested
code_editions (
  id            uuid pk,
  standard      text,                     -- 'NFPA 13'
  edition       text,                     -- '2019'
  ingested_at   timestamptz
)

-- code_sections: chunked + embedded NFPA text
code_sections (
  id            uuid pk,
  edition_id    uuid fk -> code_editions,
  section_num   text,                     -- '8.15.1.2'
  chapter       int,
  title         text,
  body          text,                     -- full section text (shown in UI)
  embedding     vector(1536),             -- text-embedding-3-small
  tokens        int,
  created_at    timestamptz
)
create index code_sections_embedding_idx on code_sections
  using hnsw (embedding vector_cosine_ops);
create index code_sections_edition_idx on code_sections (edition_id);

-- sheets: one per page of a document
sheets (
  id            uuid pk,
  document_id   uuid fk -> project_documents,
  page_number   int,
  sheet_label   text,                     -- 'FP-1.01'
  width_pt      real,
  height_pt     real
)

-- extracted_notes: raw output of the vision extractor
extracted_notes (
  id            uuid pk,
  sheet_id      uuid fk -> sheets,
  text          text,
  bbox          jsonb,                    -- {x, y, w, h} in PDF points
  note_type     text,                     -- 'citation' | 'spec' | 'dimension' | ...
  raw_model_output jsonb,                 -- audit trail
  extracted_at  timestamptz
)

-- findings: anything the agent wants the reviewer to look at
findings (
  id              uuid pk,
  project_id      uuid fk -> projects,
  sheet_id        uuid fk -> sheets,
  note_id         uuid fk -> extracted_notes nullable,
  kind            text,                   -- 'citation_mismatch' | 'spelling' | 'clarity' | 'standards' | 'missing_citation'
  severity        text,                   -- 'critical' | 'major' | 'minor' | 'info'
  message         text,                   -- human-readable
  suggested_fix   text,
  source_section_id uuid fk -> code_sections nullable,  -- the snippet we show in UI
  source_quote    text,                   -- the exact NFPA text we cited
  bbox            jsonb,                  -- where to draw the redline
  status          text default 'pending', -- 'pending' | 'accepted' | 'rejected'
  reviewed_by     text,
  reviewed_at     timestamptz,
  created_at      timestamptz
)

-- standard_notes: house QC standards (proprietary corpus)
standard_notes (
  id            uuid pk,
  category      text,                     -- 'cover sheet' | 'hydraulic' | ...
  rule          text,
  applies_when  jsonb                     -- e.g. { ahj: 'LADBS', edition: '2022' }
)

-- ahj_corrections: historical corrections from AHJ reviews (proprietary corpus)
ahj_corrections (
  id            uuid pk,
  ahj           text,
  edition       text,
  pattern       text,                     -- what to look for in notes
  correction    text,                     -- what AHJ typically demands
  source        text                      -- past project ID, comment URL, etc.
)
```

---

## 4. Folder structure

```
redline/
├── app/                              # Next.js 15 App Router
│   ├── (web)/
│   │   ├── projects/page.tsx         # list
│   │   ├── projects/[id]/page.tsx    # split-pane reviewer
│   │   └── layout.tsx                # Geist + Tailwind shell
│   ├── api/
│   │   ├── upload/route.ts           # signed Blob upload
│   │   ├── projects/[id]/review/route.ts   # start workflow
│   │   ├── findings/[id]/route.ts    # accept/reject
│   │   ├── slack/events/route.ts     # VercelReceiver
│   │   └── mcp/[transport]/route.ts  # @vercel/mcp-adapter
│   └── layout.tsx
├── components/                       # React UI (shadcn/ui-based)
│   ├── pdf-viewer.tsx                # pdfjs-dist, dynamic import, SSR off
│   ├── findings-panel.tsx
│   ├── finding-card.tsx              # shows source snippet inline
│   └── ui/                           # shadcn primitives
├── lib/
│   ├── agent/
│   │   ├── workflows/
│   │   │   └── review-sheet.ts       # "use workflow" top-level
│   │   ├── steps/                    # "use step" functions
│   │   │   ├── extract-notes.ts
│   │   │   ├── classify-note.ts
│   │   │   ├── lookup-citation.ts
│   │   │   ├── verify-claim.ts
│   │   │   ├── check-spelling.ts
│   │   │   └── render-redline.ts
│   │   ├── tools/                    # DurableAgent tool definitions (zod)
│   │   └── prompts/                  # system prompts, kept versioned
│   ├── models/
│   │   ├── gateway.ts                # AI Gateway client + ZDR helper
│   │   ├── vision.ts                 # Gemini 3 Pro wrapper
│   │   ├── verifier.ts               # Opus 4.7 wrapper
│   │   └── classifier.ts             # Haiku 4.5 wrapper
│   ├── retrieval/
│   │   ├── embed.ts                  # text-embedding-3-small
│   │   └── search.ts                 # pgvector + edition filter
│   ├── pdf/
│   │   ├── render-redline.ts         # pdf-lib annotation writer
│   │   └── coords.ts                 # bbox <-> PDF points
│   ├── slack/
│   │   └── app.ts                    # Bolt App + VercelReceiver
│   ├── mcp/
│   │   └── tools.ts                  # MCP tool surface
│   └── db.ts                         # Neon serverless client
├── db/
│   ├── schema.sql                    # tables above
│   └── migrations/
├── scripts/
│   ├── load-nfpa.ts                  # ingest NFPA chapters → code_sections
│   ├── seed-demo.ts                  # 2 demo projects with planted issues
│   └── smoke-workflow.ts             # Phase 1 smoke test
├── public/
├── ARCHITECTURE.md
├── BUILD_PLAN.md
├── package.json
├── bunfig.toml                       # local Bun config
├── vercel.json                       # runtime: nodejs (prod safety)
├── next.config.ts
├── tailwind.config.ts
└── tsconfig.json
```

---

## 5. Environment variables

| Var | Where | Purpose | Demo value source |
|---|---|---|---|
| `AI_GATEWAY_API_KEY` | Vercel + `.env.local` | One key for Gemini/Opus/Haiku/embeddings | Vercel dashboard → AI Gateway |
| `DATABASE_URL` | Vercel + `.env.local` | Neon Postgres (pooled) | Neon dashboard |
| `DATABASE_URL_UNPOOLED` | Vercel + `.env.local` | Neon direct (for migrations only) | Neon dashboard |
| `BLOB_READ_WRITE_TOKEN` | Vercel + `.env.local` | Vercel Blob | Vercel Storage tab (auto-injected on Vercel) |
| `SLACK_SIGNING_SECRET` | Vercel + `.env.local` | Slack request verification | Slack app config |
| `SLACK_BOT_TOKEN` | Vercel + `.env.local` | Slack API calls (post messages, upload files) | Slack app config |
| `SLACK_APP_TOKEN` | (not used) | Socket Mode — we don't use this; HTTP only | — |
| `MCP_BEARER_TOKEN` | Vercel + `.env.local` | Auth for the MCP endpoint (internal use) | Generated, stored in 1Password |
| `NODE_ENV` | implicit | `production` on Vercel, `development` locally | — |

**Not in env, by design**:
- Anthropic / Google / OpenAI direct keys — all traffic goes through AI Gateway with the single `AI_GATEWAY_API_KEY`.
- Claude Max credentials — Max is documented for the Claude Code CLI dev loop only (`ANTHROPIC_BASE_URL` + `x-ai-gateway-api-key` header pattern). Runtime app calls use the regular `AI_GATEWAY_API_KEY`. Documented this distinction so we don't try to wire Max into runtime code where it doesn't apply.

`.env.local` is gitignored. `.env.example` is committed with placeholder values.

---

## 6. Hobby plan compliance

For each Vercel feature we use, the limit and how we stay under it:

| Feature | Hobby limit | How we stay under |
|---|---|---|
| **Function execution** | 60s per invocation (Fluid compute Standard CPU) | Vercel Workflow splits the review into per-step invocations — each step is its own 60s window. A 50-page document is ~50+ invocations, never one long one. |
| **Function memory** | 2 GB (Fluid Standard) | Per-page extraction, never load whole PDF into memory in one step. |
| **Bandwidth** | 100 GB/mo | Demo traffic is single-digit GB. PDFs served via Blob CDN, not through functions. |
| **Vercel Blob storage** | 1 GB total | Demo PDFs are small (≤ 20 MB each). Two demo projects ≈ 80 MB. We delete intermediate artifacts after redline render. |
| **Vercel Blob ops** | 1k advanced ops/mo | Each review = 1 upload (original) + 1 upload (redlined). Plenty of headroom for the demo. |
| **AI Gateway free credit** | $5/mo | Demo is single-digit dollars. Vision pages are the cost driver — we cache extractions in Postgres so re-running a review on the same sheet is free. |
| **Cron jobs** | 2 jobs, daily only | Not used in v1. (Production will likely add a nightly NFPA reindex job — that's a Pro consideration.) |
| **Deployments** | unlimited | n/a |
| **ZDR** | not available on Hobby | Documented in §7. |
| **Bun runtime on Vercel** | Public Beta (since Oct 2025) | We deploy on **Node** for the demo to avoid beta-runtime surprises. Bun is local-dev only. |

**Workflow-step pattern that does the heavy lifting**:

```ts
// lib/agent/workflows/review-sheet.ts
"use workflow";
import { extractNotes } from "../steps/extract-notes";
import { reviewPage }   from "../steps/review-page";

export async function reviewSheet({ documentId }: { documentId: string }) {
  const pages = await loadPages(documentId);            // step 1
  const results = [];
  for (const page of pages) {
    const notes    = await extractNotes(page);          // own 60s budget
    const findings = await reviewPage(page, notes);     // own 60s budget
    results.push(findings);
  }
  return await renderRedline(documentId, results);      // own 60s budget
}
```

Each `await` of a step is a separate function invocation. Hobby's 60s ceiling never blocks a long review — only an individual step that takes >60s would, and our steps are bounded (one model call + DB write).

---

## 7. Data privacy

**Demo (Hobby)**:
- AI Gateway routes through Anthropic, Google, and OpenAI under their **default API policies**. Anthropic's default API policy prohibits training on customer prompts/completions; Google and OpenAI API endpoints likewise default to no-train.
- We do **not** have team-wide ZDR (that's a Pro/Enterprise feature on AI Gateway).
- Per-request ZDR via `providerOptions.gateway.zeroDataRetention: true` is available on the request itself, but only routes the request through providers that have ZDR agreements with Vercel — useful as a hint, not a guarantee.

**Production (Pro)**:
- Upgrade to Pro → enable team-wide ZDR on AI Gateway → every request enforced regardless of code.
- Document in `docs/PRIVACY.md` (post-v1).

**What we never send to a model**:
- Client identifying info on plan title blocks: redacted before vision extraction in production. For the internal-only demo we skip the redaction step (it's our own projects).

---

## 8. Packages

### Runtime — frameworks
| Package | Why |
|---|---|
| `next` (15.x) | App Router, route handlers, server components |
| `react`, `react-dom` (19.x) | UI |
| `typescript` | type safety |

### Runtime — AI / agent
| Package | Why |
|---|---|
| `ai` (v6.x) | Vercel AI SDK — `generateObject`, `generateText`, model routing via Gateway |
| `workflow` | Vercel Workflow SDK — `"use workflow"` / `"use step"` directives, durable execution |
| `@workflow/ai` | `DurableAgent` class — agent loop where every LLM call & tool call is its own step |
| `zod` | Schemas for tool args + structured outputs |

### Runtime — surfaces
| Package | Why |
|---|---|
| `@vercel/slack-bolt` | Slack Bolt + `VercelReceiver` (3-sec ack via Fluid `waitUntil`) |
| `@slack/bolt` | Peer dep of `@vercel/slack-bolt` |
| `@vercel/mcp-adapter` | MCP server endpoint mounted as a Next.js route handler; Streamable HTTP transport |

### Runtime — data
| Package | Why |
|---|---|
| `@neondatabase/serverless` | Neon's HTTP/WS driver, optimized for Vercel Functions |
| `drizzle-orm` | Typed query builder + migrations against Neon |
| `drizzle-kit` (dev) | Migration tooling |
| `@vercel/blob` | Signed uploads + storage for original/redlined PDFs |

### Runtime — PDF
| Package | Why |
|---|---|
| `pdf-lib` | Pure-JS PDF annotation writer (rectangles, freetext, line callouts) — runs in Node serverless |
| `pdfjs-dist` | PDF rendering in the React reviewer (use `pdfjs-dist/legacy/build/pdf.mjs` for SSR-safe import; viewer is dynamic-imported with `ssr: false`) |

### Runtime — UI
| Package | Why |
|---|---|
| `tailwindcss`, `@tailwindcss/postcss` | styling |
| `geist` | Geist font (Vercel's typeface) |
| `lucide-react` | icons |
| `class-variance-authority`, `clsx`, `tailwind-merge` | shadcn primitives' deps |
| `@radix-ui/*` (selective) | shadcn/ui underlying primitives — install per-component |

### Runtime — utilities
| Package | Why |
|---|---|
| `nanoid` | short IDs for findings/notes |
| `typo-js` | spellcheck for `checkSpelling` tool |

### Dev
| Package | Why |
|---|---|
| `bun` (local only — system) | local dev runtime, package install |
| `eslint`, `eslint-config-next` | lint |
| `prettier`, `prettier-plugin-tailwindcss` | format |
| `tsx` | run `scripts/*.ts` files locally |
| `vitest` | tests for retrieval + redline coord math (the parts that need to be deterministic) |

**Install commands (local, Bun)**:
```bash
bun add next react react-dom ai workflow @workflow/ai zod
bun add @vercel/slack-bolt @slack/bolt @vercel/mcp-adapter
bun add @neondatabase/serverless drizzle-orm @vercel/blob
bun add pdf-lib pdfjs-dist
bun add tailwindcss @tailwindcss/postcss geist lucide-react
bun add class-variance-authority clsx tailwind-merge
bun add nanoid typo-js
bun add -d typescript @types/react @types/react-dom @types/node
bun add -d drizzle-kit eslint eslint-config-next prettier prettier-plugin-tailwindcss tsx vitest
```

`vercel.json` pins Node for prod:

```json
{
  "functions": {
    "app/api/**/route.ts": { "runtime": "nodejs22.x" }
  }
}
```
