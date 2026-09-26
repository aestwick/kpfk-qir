import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Next.js patches the global fetch inside the app server and stores GET
// responses in its Data Cache, keyed on the full request URL — for a PostgREST
// read that key is the entire query (station, filters, limit, updated_since,
// cursor …) and the default entry never expires. A route marked force-dynamic
// escapes the Full Route Cache but its inner fetches can still be served from
// the Data Cache, which is how /api/v1 responses were observed frozen for 13+
// hours while a one-character change to the query string returned fresh rows.
// Every server-side Supabase read goes through this wrapper so database reads
// are NEVER cached by the framework; response caching is done deliberately in
// Redis (lib/api-cache.ts) with explicit TTLs. Outside Next (the BullMQ
// workers) the option is inert — plain undici fetch accepts and ignores it.
const noStoreFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: 'no-store' })

let _supabaseAdmin: SupabaseClient | null = null

// Server-side client with service role key (for workers and API routes)
// Lazy-initialized to avoid errors during Next.js build when env vars aren't set
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    if (!_supabaseAdmin) {
      _supabaseAdmin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { global: { fetch: noStoreFetch } }
      )
    }
    return (_supabaseAdmin as any)[prop]
  },
})

// Client-side client with anon key (for browser)
export function createBrowserClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

// Request-scoped server client bound to a caller's access token, so Postgres
// RLS applies to its queries. Used by API routes that serve a user action
// (workers keep using supabaseAdmin, which bypasses RLS by design).
export function createServerClient(accessToken: string) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` }, fetch: noStoreFetch },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  )
}
