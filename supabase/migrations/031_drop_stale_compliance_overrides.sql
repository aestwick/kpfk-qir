-- Compliance prompt + blocking became MASTER-level (global-only) — the worker now
-- reads them from qir_settings with no per-station override (lib/settings.ts).
-- Any pre-existing station_settings overrides for these keys are now dead data
-- that would still surface in GET /api/settings (effective value = override wins),
-- showing a value the worker ignores. Drop them so display == enforcement.
--
-- compliance_checks_enabled is intentionally NOT dropped — it stays central-default
-- + per-station override.

delete from public.station_settings
  where key in ('compliance_prompt', 'compliance_blocking');
