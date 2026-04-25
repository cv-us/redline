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
