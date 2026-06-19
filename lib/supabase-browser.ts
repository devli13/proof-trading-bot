"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser Supabase client for Realtime broadcast only. The anon key is PUBLIC by design
// (RLS is the security boundary; anon may SELECT only the 3 non-sensitive tables + the
// change log — never the keys table). A single lazily-created singleton per tab.
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (typeof window === "undefined") return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 5 } },
    });
  }
  return client;
}
