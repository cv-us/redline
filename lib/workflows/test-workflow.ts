import { sql } from "@/lib/db";

// Phase 1 smoke test. Three durable steps, each its own function invocation,
// each returning a timestamp so we can prove they ran in order with real
// elapsed time between them. Persist a row to Neon at the end so we can
// confirm the workflow reached completion outside the HTTP response.

async function stepOne() {
  "use step";
  return { step: 1, name: "stepOne", ts: new Date().toISOString() };
}

async function stepTwo(prev: { ts: string }) {
  "use step";
  return {
    step: 2,
    name: "stepTwo",
    ts: new Date().toISOString(),
    elapsedMsSincePrev: Date.now() - new Date(prev.ts).getTime(),
  };
}

async function stepThreePersist(log: unknown) {
  "use step";
  const ts = new Date().toISOString();
  // Idempotent insert: workflow_runs is a smoke-test table from db/schema.sql.
  // Best-effort — if DATABASE_URL isn't configured locally, swallow so the
  // workflow itself still proves out.
  try {
    await sql()`
      insert into workflow_runs (workflow, step_log)
      values ('test-workflow', ${JSON.stringify(log)}::jsonb)
    `;
  } catch (err) {
    return { step: 3, name: "stepThreePersist", ts, persisted: false, error: String(err) };
  }
  return { step: 3, name: "stepThreePersist", ts, persisted: true };
}

export async function runTestWorkflow() {
  "use workflow";

  const a = await stepOne();
  const b = await stepTwo(a);
  const c = await stepThreePersist({ a, b });

  return {
    workflow: "test-workflow",
    steps: [a, b, c],
    finishedAt: new Date().toISOString(),
  };
}
