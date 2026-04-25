import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let cached: NeonQueryFunction<false, false> | null = null;

// Lazy: don't crash module load if DATABASE_URL is missing (build-time
// step collection imports workflow files; Neon need only resolve at runtime).
export function sql(): NeonQueryFunction<false, false> {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  }
  cached = neon(url);
  return cached;
}
