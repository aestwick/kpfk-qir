import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _supabaseAdmin: SupabaseClient | null = null

// Server-side client with service role key (for workers and API routes)
// Lazy-initialized to avoid errors during Next.js build when env vars aren't set
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    if (!_supabaseAdmin) {
      _supabaseAdmin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
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
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  )
}

// Apply the tenant guard to a query builder. The background workers run on the
// service-role client (RLS bypassed), so this `station_id` filter is their ONLY
// isolation guard — funnelling those queries through one named, greppable helper
// keeps the guard explicit and makes "did we scope this?" easy to audit.
//
// For queries whose own table carries `station_id` only — NOT join-qualified
// filters like `.eq('episode_log.station_id', …)`. API routes don't need it:
// they have Postgres RLS as a backstop under the explicit filter.
//
//   stationScoped(supabaseAdmin.from('episode_log').select('*'), stationId)
//     .eq('status', 'pending')
//
// T is inferred from the passed builder and returned unchanged so the result
// keeps chaining (.eq/.in/.gte/…); the unconstrained generic + local cast avoids
// the "excessively deep" instantiation Supabase's recursive builder types
// trigger under a self-referential `T extends { eq(): T }` constraint.
export function stationScoped<T>(query: T, stationId: string): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (query as any).eq('station_id', stationId)
}
