import { NextRequest } from 'next/server'
import { supabaseAdmin } from './supabase'

// ===========================================================================
// Audit Log — app-layer capture helper. See ideas/AUDIT_LOG_SPEC.md.
//
// Mirrors lib/usage.ts: a service-role insert that is FIRE-AND-FORGET and must
// never throw into the request path. DB triggers (migration 028) already record
// every data mutation; this helper records what triggers structurally can't see:
// reads/views, auth events, exports/downloads, and semantic system events.
//
// ▸▸ SINGLE SOURCE OF TRUTH FOR APP-LAYER EVENT TYPES ◂◂
// Every new audit action/operation MUST be registered below — in AUDIT_OPERATIONS
// (the low-level verb, which is also constrained by the DB check) and in
// AUDIT_ACTIONS (the dotted semantic action). Don't sprinkle bare action strings
// at call sites; reference AUDIT_ACTIONS.* so the set stays enumerable, the
// client allowlist (CLIENT_AUDIT_EVENTS) derives from it, and the dashboard
// filter knows what exists. Mutations recorded by triggers use a separate
// `<table>.<insert|update|delete>` convention and are not listed here.
// ===========================================================================

// Low-level verbs. MUST match the `operation` CHECK constraint in migration 028.
export const AUDIT_OPERATIONS = [
  'insert',
  'update',
  'delete',
  'read',
  'login',
  'logout',
  'export',
  'login_failed',
  'station_switch',
] as const
export type AuditOperation = (typeof AUDIT_OPERATIONS)[number]

// Dotted semantic actions emitted by the app layer. Grouped by concern. ADD NEW
// EVENT TYPES HERE — this is the registry the rest of the app reads from.
export const AUDIT_ACTIONS = {
  // Reads / views (selective — see spec §6.1; Postgres can't trigger on SELECT)
  EPISODE_READ: 'episode.read',
  TRANSCRIPT_READ: 'transcript.read',
  MEMBERS_READ: 'members.read',
  USERS_READ: 'users.read',
  REPORT_READ: 'report.read',

  // User / access management (super-admin Users page). Attributes the actor on
  // the supabaseAdmin (service-role) writes that DB triggers would otherwise log
  // as 'system'. The grant/revoke of global super-admin is high-sensitivity.
  USER_ACCESS_GRANT: 'users.access.grant',
  USER_ACCESS_UPDATE: 'users.access.update',
  USER_ACCESS_REVOKE: 'users.access.revoke',
  USER_PASSWORD_RESET: 'users.password.reset',
  SUPER_ADMIN_GRANT: 'users.super.grant',
  SUPER_ADMIN_REVOKE: 'users.super.revoke',

  // API key lifecycle (programmatic read API). Attributes the actor on the
  // service-role writes that DB triggers would otherwise record as 'system'.
  API_KEY_CREATE: 'api_key.create',
  API_KEY_REVOKE: 'api_key.revoke',

  // Exports / downloads
  EPISODES_EXPORT: 'episodes.export',
  REPORT_EXPORT: 'report.export',
  DOWNLOADS_EXPORT: 'downloads.export',

  // Auth / session (client-reported — Supabase Auth runs in the browser)
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGIN_FAILED: 'auth.login_failed',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_STATION_SWITCH: 'auth.station_switch',

  // System events from workers (the "which job / which counts" detail the generic
  // trigger can't express). Recorded with actorId: null => actor_type 'system'.
  INGEST_COMPLETE: 'ingest.complete',
  DISCOVERY_SYNC_COMPLETE: 'discovery.sync.complete',
  TRANSCRIBE_COMPLETE: 'transcribe.complete',
  SUMMARIZE_COMPLETE: 'summarize.complete',
  COMPLIANCE_COMPLETE: 'compliance.complete',
  QIR_GENERATE_COMPLETE: 'qir.generate.complete',
  // Broadcast-week verification run (scripts/verify-week.ts): bulk transcript
  // read + report file export, plus the optional AI content-check pass.
  VERIFY_WEEK_COMPLETE: 'verify.week.complete',
} as const
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]

// The subset of events a browser client may POST to /api/audit/event, mapping
// each allowed action to its required operation. Anything outside this allowlist
// is rejected so clients can't forge arbitrary audit rows. `anonymousOk` marks
// events that may be posted without a valid session (a failed login has none).
export const CLIENT_AUDIT_EVENTS: Record<
  string,
  { operation: AuditOperation; anonymousOk?: boolean }
> = {
  [AUDIT_ACTIONS.AUTH_LOGIN]: { operation: 'login' },
  [AUDIT_ACTIONS.AUTH_LOGIN_FAILED]: { operation: 'login_failed', anonymousOk: true },
  [AUDIT_ACTIONS.AUTH_LOGOUT]: { operation: 'logout' },
  [AUDIT_ACTIONS.AUTH_STATION_SWITCH]: { operation: 'station_switch' },
}

export interface AuditEventInput {
  stationId?: string | null
  actorId?: string | null            // omit/null => system
  // Prefer an AuditAction constant; `string` is allowed so trigger-style or
  // future actions aren't blocked at the type level, but register reusable ones.
  action: AuditAction | string
  resourceType?: string | null
  resourceId?: string | number | null
  operation: AuditOperation
  // Set explicitly to record an anonymous (public/no-JWT) actor distinctly from
  // a system actor. When omitted, actor_type is 'user' if actorId is set else
  // 'system'.
  anonymous?: boolean
  metadata?: Record<string, unknown>
  ip?: string | null
  userAgent?: string | null
}

/**
 * Append a row to audit_log. Fire-and-forget: never throws into the caller — a
 * failed audit write logs to console and is swallowed, exactly like lib/usage.ts.
 */
export async function logAuditEvent(e: AuditEventInput): Promise<void> {
  try {
    const actorType = e.anonymous ? 'anonymous' : e.actorId ? 'user' : 'system'
    await supabaseAdmin.from('audit_log').insert({
      station_id: e.stationId ?? null,
      actor_id: e.actorId ?? null,
      actor_type: actorType,
      action: e.action,
      resource_type: e.resourceType ?? null,
      resource_id: e.resourceId != null ? String(e.resourceId) : null,
      operation: e.operation,
      metadata: e.metadata ?? {},
      ip_address: e.ip ?? null,
      user_agent: e.userAgent ?? null,
    })
  } catch (err) {
    console.error('logAuditEvent failed:', err)
  }
}

/** Pull client IP + user-agent from a request for audit context. */
export function requestMeta(request: NextRequest): { ip: string | null; userAgent: string | null } {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    null
  return { ip, userAgent: request.headers.get('user-agent') }
}
