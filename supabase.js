import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required. Copy .env.example to .env.local."
  );
}

/**
 * The anon key is public by design — Vite inlines it into the bundle and anyone
 * can read it. It identifies the project; it authorises nothing.
 *
 * All authorisation lives in Row Level Security and in the SECURITY DEFINER
 * functions in supabase/migrations. Every table denies anon by default, and the
 * only writes this client can perform are the four seat-hold RPCs.
 *
 * If RLS is ever disabled on a table, this key becomes full access to it.
 */
export const supabase = createClient(url, anonKey, {
  auth: { persistSession: false },
  global: { headers: { "x-application-name": "safaritiketi-web" } },
});

export const functionsUrl = `${url.replace(/\/$/, "")}/functions/v1`;
export const anonHeaders = { apikey: anonKey, authorization: `Bearer ${anonKey}` };
