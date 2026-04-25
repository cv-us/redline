-- Redline schema. Canonical source: ARCHITECTURE.md §3.
-- Apply against Neon: psql "$DATABASE_URL_UNPOOLED" -f db/schema.sql

create extension if not exists vector;
create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- projects: one per design job
create table if not exists projects (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  ahj           text,
  nfpa_edition  text not null,                  -- '2019' | '2022'
  created_at    timestamptz not null default now()
);

-- code_editions: registry of NFPA editions we've ingested
create table if not exists code_editions (
  id            uuid primary key default gen_random_uuid(),
  standard      text not null,                  -- 'NFPA 13'
  edition       text not null,                  -- '2019'
  ingested_at   timestamptz not null default now(),
  unique (standard, edition)
);

-- code_sections: chunked + embedded NFPA text
create table if not exists code_sections (
  id            uuid primary key default gen_random_uuid(),
  edition_id    uuid not null references code_editions(id) on delete cascade,
  section_num   text not null,                  -- '8.15.1.2'
  chapter       int,
  title         text,
  body          text not null,
  embedding     vector(1536),                   -- text-embedding-3-small
  tokens        int,
  created_at    timestamptz not null default now()
);
create index if not exists code_sections_embedding_idx
  on code_sections using hnsw (embedding vector_cosine_ops);
create index if not exists code_sections_edition_idx
  on code_sections (edition_id);
create index if not exists code_sections_section_num_idx
  on code_sections (edition_id, section_num);

-- project_documents: original PDFs uploaded for a project
create table if not exists project_documents (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  blob_url      text not null,
  redlined_url  text,
  page_count    int,
  uploaded_at   timestamptz not null default now()
);
create index if not exists project_documents_project_idx
  on project_documents (project_id);

-- sheets: one per page of a document
create table if not exists sheets (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references project_documents(id) on delete cascade,
  page_number   int not null,
  sheet_label   text,
  width_pt      real,
  height_pt     real,
  unique (document_id, page_number)
);

-- extracted_notes: raw output of the vision extractor
create table if not exists extracted_notes (
  id               uuid primary key default gen_random_uuid(),
  sheet_id         uuid not null references sheets(id) on delete cascade,
  text             text not null,
  bbox             jsonb not null,              -- {x, y, w, h} in PDF points
  note_type        text,                        -- 'citation' | 'spec' | 'dimension' | 'general' | 'header'
  raw_model_output jsonb,
  extracted_at     timestamptz not null default now()
);
create index if not exists extracted_notes_sheet_idx
  on extracted_notes (sheet_id);

-- findings: anything the agent wants the reviewer to look at
create table if not exists findings (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects(id) on delete cascade,
  sheet_id          uuid not null references sheets(id) on delete cascade,
  note_id           uuid references extracted_notes(id) on delete set null,
  kind              text not null,              -- 'citation_mismatch' | 'spelling' | 'clarity' | 'standards' | 'missing_citation'
  severity          text not null,              -- 'critical' | 'major' | 'minor' | 'info'
  message           text not null,
  suggested_fix     text,
  source_section_id uuid references code_sections(id) on delete set null,
  source_quote      text,
  bbox              jsonb,
  status            text not null default 'pending',  -- 'pending' | 'accepted' | 'rejected'
  reviewed_by       text,
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists findings_project_idx on findings (project_id);
create index if not exists findings_sheet_idx on findings (sheet_id);
create index if not exists findings_status_idx on findings (project_id, status);

-- Enforced at write-time per ARCHITECTURE.md §9 risk #2: every citation
-- finding must carry the retrieved source so the human can verify it.
alter table findings drop constraint if exists findings_citation_source_required;
alter table findings add constraint findings_citation_source_required
  check (
    kind not like 'citation_%'
    or (source_section_id is not null and source_quote is not null)
  );

-- standard_notes: house QC standards (proprietary corpus)
create table if not exists standard_notes (
  id            uuid primary key default gen_random_uuid(),
  category      text not null,
  rule          text not null,
  applies_when  jsonb
);

-- ahj_corrections: historical corrections from AHJ reviews (proprietary corpus)
create table if not exists ahj_corrections (
  id            uuid primary key default gen_random_uuid(),
  ahj           text not null,
  edition       text,
  pattern       text not null,
  correction    text not null,
  source        text
);

-- workflow_runs: smoke-test table for Phase 1 /api/test-workflow.
-- Drop or repurpose later once real workflow tracking is in place.
create table if not exists workflow_runs (
  id            uuid primary key default gen_random_uuid(),
  workflow      text not null,
  step_log      jsonb not null,
  finished_at   timestamptz not null default now()
);
