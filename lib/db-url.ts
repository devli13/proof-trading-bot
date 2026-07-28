/**
 * Prefer Supabase's TRANSACTION pooler (port 6543) over the SESSION pooler (5432) for the
 * serverless API routes. Session mode holds one server connection per client session, and a
 * serverless function that times out dies before closing it — so connections leak and pile up
 * until the ~40-client session pool is exhausted and every new request hangs. The transaction
 * pooler returns the connection after each transaction, so it scales to serverless cleanly.
 *
 * Same host + credentials — only the port differs — so we derive it from DATABASE_URL rather
 * than needing a second secret. No-op for non-Supabase-pooler URLs (e.g. a direct connection).
 */
export function txPoolerUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.includes("pooler.supabase.com:5432") ? url.replace(":5432/", ":6543/") : url;
}
