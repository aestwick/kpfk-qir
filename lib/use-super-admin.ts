'use client'

import { useEffect, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

/**
 * Client-side check for whether the signed-in user is a super admin. Mirrors the
 * lookup in getStationContext / the station switcher (a direct super_admins read,
 * gated by RLS). Returns null while loading, then true/false.
 *
 * This is UX only — it hides super-admin surfaces (e.g. cost/usage) from ordinary
 * members. The authoritative gate is server-side (requireSuperAdmin in the API).
 */
export function useIsSuperAdmin(): boolean | null {
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    async function check() {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        if (!cancelled) setIsSuperAdmin(false)
        return
      }
      const { data } = await supabase
        .from('super_admins')
        .select('user_id')
        .eq('user_id', session.user.id)
        .maybeSingle()
      if (!cancelled) setIsSuperAdmin(!!data)
    }
    check()
    return () => { cancelled = true }
  }, [])

  return isSuperAdmin
}
