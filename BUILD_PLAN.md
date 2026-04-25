# Redline — Build plan

Demo-scoped phased plan. Each phase ends with something demo-able. We do not start a phase until the previous phase's "done" criteria pass.

**Cadence**: each phase is sized to fit in one focused work block. The order is dependency-driven, not parallelizable — Phase 4 needs Phase 3's corpus, Phase 6 needs Phase 5's accept/reject UI, etc. Phases 7 and 8 (Slack, MCP) can swap order if convenient.

---

## Phase 1 — Skeleton

**Goal**: Next.js app that runs locally on Bun, deploys to Vercel on Node, can talk to Neon, can write a Blob, and can run a "hello workflow" with a multi-step durable execution.

**Tasks**:
1. `bun create next-app` (TypeScript, App Router, Tailwind, no src/, no ESLint preset).
2. Add Geist (`import { GeistSans, GeistMono } from "geist/font"`).
3. Initialize shadcn/ui (`bunx shadcn@latest init`); install `button`, `card`, `dialog`, `tabs`, `badge`, `separator`, `scroll-area`, `tooltip`, `toast`.
4. Wire up Neon: create project on Neon dashboard with pgvector enabled; install `@neondatabase/serverless` + `drizzle-orm` + `drizzle-kit`; write `lib/db.ts` exporting a Neon client; commit a minimal `db/schema.ts` with `projects` table only.
5. Wire up Vercel Blob: create store in Vercel dashboard; install `@vercel/blob`; write `app/api/upload/route.ts` returning a signed upload URL.
6. Install `workflow` and `@workflow/ai`; add `app/api/hello-workflow/route.ts` that starts a 3-step workflow (`fetch a number → double it → write to Postgres`) using the `"use workflow"` and `"use step"` directives.
7. `vercel.json` pins all `app/api/**` routes to `nodejs22.x` runtime.
8. Deploy to Vercel; confirm the hello-workflow runs end to end on the deployed env (check Workflow logs in the dashboard).
9. **Bun runtime smoke test**: locally, `bun run dev` boots the dev server; `bun --bun next dev` works; verify Neon HTTP driver works under Bun.

**Done when**:
- `bun run dev` boots locally with the shell page rendering Geist + a Tailwind-styled button.
- Hitting `/api/hello-workflow` on the deployed Vercel app inserts a row in Neon, and the workflow shows 3 separate steps in the Workflow UI.
- A test file uploaded via the signed URL appears in Vercel Blob storage.

---

## Phase 2 — PDF upload + extraction agent

**Goal**: A user can upload a multi-page sprinkler plan PDF; the system extracts every text annotation per page using Gemini 3 Pro vision, and stores `extracted_notes` rows with bounding boxes.

**Tasks**:
1. Migrate `db/schema.ts` to add `project_documents`, `sheets`, `extracted_notes` tables.
2. Build the upload UI: drop zone (shadcn) → POST signed URL → PUT to Blob → POST `/api/projects/:id/document` to register and start ingest.
3. Implement `lib/pdf/split-pages.ts`: takes a Blob URL, uses `pdf-lib` to count pages and emit per-page references (we don't materialize per-page PDFs yet; we pass `{documentId, pageNumber}` to the vision step and let it render the page from the original).
4. Build `lib/agent/steps/extract-notes.ts` (`"use step"`): renders one page to PNG via `pdfjs-dist/legacy`, sends to `google/gemini-3-pro-preview` via AI SDK `generateObject` with a zod schema requiring `{ notes: { text, bbox: {x,y,w,h}, type }[] }`.
5. Add a `lib/agent/workflows/ingest-document.ts` (`"use workflow"`) that fans out one `extractNotes` step per page, then writes results to `extracted_notes`.
6. Trigger it from `/api/projects/:id/review` (a stub of the Phase 4 endpoint — for now it just runs ingest, no verification).
7. UI: project page shows "extracting…" then a JSON preview of the extracted notes per page.

**Done when**:
- Uploading a real ≤ 10-page demo PDF produces ≥ 80% of the visible notes in `extracted_notes` with usable bboxes.
- Each page's extraction is its own workflow step in the Workflow UI.
- Reviewing the same document twice doesn't re-extract (idempotency: skip if `extracted_notes` rows exist for that sheet).

---

## Phase 3 — NFPA code corpus loader

**Goal**: NFPA 13 chapters 8 ("Installation Requirements") and 11 ("Design Approaches") for editions 2019 and 2022 are chunked, embedded with `openai/text-embedding-3-small` via AI Gateway, and stored in `code_sections` with `pgvector` indexes. We can semantically search a citation string and get the right section, edition-filtered.

**Tasks**:
1. Migrate schema: add `code_editions` and `code_sections` tables; create the HNSW index on `embedding`.
2. Manually prepare source text: for each (standard, edition, chapter), produce a JSON of `{section_num, title, body}` chunks. Sourced from sanitized internal copies (we have licensed access for our firm's use).
3. Write `scripts/load-nfpa.ts`: reads a JSON file, embeds each section's `title + body` via AI SDK `embed` against `openai/text-embedding-3-small`, inserts into `code_sections` with the matching `edition_id`.
4. Write `lib/retrieval/search.ts`: takes `(query: string, editionId: string, k: number)`, embeds the query, runs a `vector_cosine_ops` HNSW search filtered by `edition_id`, returns the top-k sections with full body text and similarity scores.
5. Write `lib/agent/steps/lookup-citation.ts` (`"use step"`): wraps `search.ts`, accepts `(citationString, editionId)`, returns top-k results.
6. Smoke test: a known citation like `"NFPA 13 8.15.1.2"` against the 2022 corpus returns the correct section as top-1; the same query against the 2019 corpus returns 2019's version (different text), not 2022's.

**Done when**:
- Both editions are loaded; row counts match expectations (eyeball check).
- Vector search returns sub-300ms locally and from a Vercel Function.
- Edition filter is enforced (a 2022 project literally cannot retrieve a 2019 section — verified by a unit test in vitest).

---

## Phase 4 — Verification pipeline

**Goal**: A DurableAgent runs over the extracted notes, classifies them, looks up citations, verifies claims against retrieved NFPA text using Opus 4.7, and writes structured `findings` rows. Strict retrieval-only architecture — no model ever fabricates a citation.

**Tasks**:
1. Migrate schema: add `findings` table (with `source_section_id` and `source_quote` columns).
2. Build the agent tools (each a zod-typed function exposed to `DurableAgent`):
   - `classifyNote` → Haiku 4.5, returns `'citation' | 'spec' | 'dimension' | 'general' | 'header'`.
   - `lookupCitation` → from Phase 3.
   - `verifyCitationClaim` → Opus 4.7, input `{ noteText, retrievedSection: { num, body } }`, output `{ verdict: 'matches' | 'mismatch' | 'unknown', evidenceQuote, suggestedFix }`. System prompt forbids paraphrase: evidence must be a substring of the retrieved body.
   - `checkSpelling` → typo-js + sprinkler glossary, deterministic.
3. Build `DurableAgent` instance in `lib/agent/workflows/review-document.ts`:
   - System prompt: anti-hallucination charter (citations only via tool; unknown verdict if no retrieval; quote evidence verbatim).
   - For citation notes: `tool_choice: "required"` on `lookupCitation`.
   - Outputs structured `findings` with zod schema validation.
4. Wire `/api/projects/:id/review` to start the full pipeline: ingest (Phase 2) → review (this phase). Skip ingest if already done.
5. Acceptance test: feed in a known-bad sheet (citation says "8.15.1.2 requires X" but the actual section says Y) — verifier should produce a `citation_mismatch` finding with the correct source quote.

**Done when**:
- A 5-page test PDF produces a list of `findings` rows with severities, source quotes, and bboxes.
- Manually-planted citation errors are caught (`mismatch` verdict).
- An invalid citation string ("NFPA 99.99.99") produces an `unknown` verdict, never a fabricated one.
- Every citation finding has a non-null `source_section_id` and `source_quote`.

---

## Phase 5 — React review UI

**Goal**: Reviewer opens a project, sees a split-pane view: PDF on the left, findings panel on the right. Clicking a finding pans/highlights the bbox. Each finding shows the source NFPA snippet inline. Reviewer can accept/reject each finding.

**Tasks**:
1. Build `components/pdf-viewer.tsx`: `pdfjs-dist/legacy` for rendering, dynamic-imported with `ssr: false`, supports rendering a single page with a canvas overlay where we draw bboxes.
2. Build `components/findings-panel.tsx`: grouped by severity (`critical / major / minor / info`), sorted by sheet then by reading order.
3. Build `components/finding-card.tsx`: shows kind, message, suggested fix, **the exact NFPA source snippet** (from `source_quote`) with section number, plus accept/reject buttons.
4. Wire bbox click-through: clicking a finding scrolls the PDF to its sheet and draws a temporary highlight.
5. `PATCH /api/findings/:id` to accept or reject.
6. Page polls (or server-sends) until workflow completes; show progress indicator while extraction/review steps run.
7. Keyboard shortcuts: `j/k` next/prev finding, `a` accept, `r` reject (small accelerator for power users — me).

**Done when**:
- The reviewer view renders the demo PDF with all findings displayed.
- Source NFPA snippet is visible on every citation finding.
- Accept/reject persists and updates the `findings.status` column.
- The full review of a 5-page demo doc completes start-to-finish in the UI.

---

## Phase 6 — Redlined PDF export

**Goal**: After review, generate a redlined PDF using `pdf-lib` that draws annotations only for `accepted` findings. Output PDF saved to Blob; URL surfaced to UI/Slack/MCP.

**Tasks**:
1. Build `lib/pdf/render-redline.ts` (`"use step"`):
   - Loads original PDF from Blob.
   - For each accepted finding, draws a colored rectangle around its bbox (red = critical, orange = major, yellow = minor) and a freetext callout with the message + section reference.
   - Adds a cover page summarizing finding counts by severity.
2. Add `renderRedline` step at the end of the review workflow (only runs when reviewer hits "Export").
3. Save output to Vercel Blob; update `project_documents.redlined_url`.
4. UI: "Export redline" button → spinner → download link when done.

**Done when**:
- A redlined PDF downloads cleanly, every accepted finding visible, severity-color-coded.
- File size is reasonable (no unnecessary rasterization — we annotate the original).
- A second export overwrites cleanly (idempotent given the same set of accepted findings).

---

## Phase 7 — Slack bot

**Goal**: `/qc-sheet` slash command (or `@redline` mention) with an attached PDF runs a review and posts the redlined PDF + a findings summary back to the Slack thread.

**Tasks**:
1. Create Slack app in our workspace; install `@vercel/slack-bolt` and `@slack/bolt`; configure scopes (`commands`, `files:read`, `files:write`, `chat:write`).
2. Build `app/api/slack/events/route.ts` using `VercelReceiver` with `deferInitialization: true`. The receiver acks Slack within 3s using Fluid `waitUntil`, then continues processing in background.
3. Handle `command:/qc-sheet`: download attached PDF (Slack files API) → upload to Blob → start review workflow → post a "Started review of `<filename>`" reply.
4. Handle `event:app_mention` similarly.
5. When the review workflow completes, post a thread reply: findings summary (counts by severity) + a link to the web UI for accept/reject + the redlined PDF as an upload (or Blob link if too large).
6. `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` set in Vercel env.

**Done when**:
- Slash command `/qc-sheet` with a PDF attached produces a "review started" reply within Slack's 3s window.
- The thread receives a follow-up with the findings summary.
- The redlined PDF appears in the thread either as a file upload or a clickable link.

---

## Phase 8 — MCP server endpoint

**Goal**: External MCP clients (Cursor, Claude Desktop, etc.) can call Redline's review tools over MCP.

**Tasks**:
1. Install `@vercel/mcp-adapter`; mount `app/api/mcp/[transport]/route.ts` with Streamable HTTP enabled.
2. Expose tools:
   - `redline.startReview({ blobUrl, edition })` → returns `reviewId`
   - `redline.getReviewStatus({ reviewId })` → returns status + counts
   - `redline.listFindings({ reviewId, status? })` → returns findings with source snippets
   - `redline.exportRedline({ reviewId })` → returns Blob URL of redlined PDF
3. Auth: simple `Authorization: Bearer <MCP_BEARER_TOKEN>` header check (internal only — fine for v1).
4. Smoke test from Cursor: register the MCP server, invoke `redline.startReview` against a Blob URL, confirm `listFindings` returns expected output.

**Done when**:
- The MCP endpoint registers cleanly in Cursor (or Claude Desktop).
- All 4 tools return correctly typed results.
- An end-to-end "start → poll → list → export" call sequence works.

---

## Phase 9 — Demo polish

**Goal**: Demo lands cleanly. Two pre-loaded projects with planted issues, smooth narration script, no live failures.

**Tasks**:
1. Pick two demo projects:
   - **Project A**: NFPA 13 2022 edition, mid-sized warehouse. Plant: one note that cites `8.15.1.2` but states a requirement that exists in 2019 only (catches the edition-mismatch case).
   - **Project B**: NFPA 13 2019 edition, school. Plant: a misspelling, an ambiguous note, a missing citation on a spec callout.
2. `scripts/seed-demo.ts`: idempotently seeds both projects (`projects` rows + uploaded PDFs in Blob + the planted issues).
3. Pre-warm: run extraction + review on both projects ahead of the demo so they appear "instantly reviewed" (don't make the audience watch 5 minutes of vision extraction).
4. Demo script written down: 3-min walkthrough — upload → review running → split-pane → accept/reject → export → Slack demo → MCP demo.
5. Failure-mode rehearsal: cold-cache run, hot-cache run, network blip mid-workflow (verify resumability).
6. README with one-paragraph pitch and a screenshot.

**Done when**:
- Cold demo runs end-to-end without intervention.
- Demo script is timed and rehearsed.
- Both demo projects show meaningful findings with NFPA source snippets visible.
