# Infrastructure & Configuration

Operational configuration for QIR.KPFK.ORG — the GitHub, VPS, and Supabase
settings that aren't captured in code. This is the home for "how is the
deployment/repo set up and *why*" decisions.

For deployment **topology** see `ARCHITECTURE.md §4`; for local/Docker setup
steps see `README.md`. For product/code design decisions see
`ideas/DECISION_LOG.md`.

---

## GitHub

### Branch protection (`main`) — minimal ruleset, no PR requirement

**Set:** 2026-06-20

The `main` branch ruleset enables only:
- **Restrict deletions** — on
- **Block force pushes** — on

Intentionally **not** enabled:
- **Require a pull request before merging** — left off, so direct uploads/commits
  to `main` (e.g. occasional file uploads via the GitHub web UI) still work.
- Require status checks, signed commits, linear history, restrict
  creations/updates, etc.

**Why:** effectively a solo repo (owner + Claude). Claude already routes all of
its work through PRs, and the owner occasionally uploads files directly to
`main`. The two enabled rules protect against accidental history rewrites and
branch deletion without blocking normal commits or direct uploads. The existing
CI (`.github/workflows/build.yml`) only runs on push to `main` and
builds/pushes the Docker image — it is **not** a PR-triggered check, so there is
nothing meaningful to gate on with "Require status checks to pass" yet.

**Revisit if** the project gains additional contributors, or we add a
PR-triggered CI job (lint/typecheck/build) — at which point enabling "Require a
pull request" + "Require status checks" (with the owner on the bypass list for
manual uploads) becomes worthwhile.

### CI / CD

- `.github/workflows/build.yml` — builds and pushes the Docker image to
  `ghcr.io/aestwick/kpfk-qir` on every push to `main`. Uses the `QIR env`
  environment for secrets (`NEXT_PUBLIC_SUPABASE_ANON_KEY`). Not run on PRs.

---

## VPS

See `ARCHITECTURE.md §4` for the full topology. Summary:
- Behind a **Traefik** reverse proxy (TLS) at `qir.kpfk.org`.
- `qir-app` (Next.js) and `qir-worker` (BullMQ) run as separate containers from
  the same Docker image with different `CMD`s.
- `qir-redis` (Alpine) sidecar with a persistent volume for queue state.
- DB migrations are applied during deploy (see `ideas/DECISION_LOG.md` A12.1).

---

## Supabase

- Hosted (not self-hosted) PostgreSQL + Auth.
- All persistent state lives here; schema is managed via `supabase/migrations/`.
- Anon key is injected at Docker build time via the `QIR env` GitHub environment
  secret; service-role key is used by workers at runtime.
