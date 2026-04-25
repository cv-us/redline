import { start } from "workflow/api";
import { NextResponse } from "next/server";
import { runTestWorkflow } from "@/lib/workflows/test-workflow";

export const runtime = "nodejs";

export async function GET() {
  const run = await start(runTestWorkflow, []);
  const result = await run.returnValue;
  return NextResponse.json(result);
}
