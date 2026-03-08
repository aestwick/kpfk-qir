## Phase 14.5: Component Decomposition

Before the dashboard redesign, break up god components so Phase 15 has clean pieces to work with:

**Dashboard overview** (`app/dashboard/page.tsx`) — extract into:
- `components/dashboard/status-cards.tsx`
- `components/dashboard/quick-actions.tsx`
- `components/dashboard/quarter-progress.tsx`
- `components/dashboard/recent-activity.tsx`

**Episode detail** (`app/dashboard/episodes/[id]/page.tsx`) — extract into:
- `components/episodes/episode-metadata.tsx`
- `components/episodes/transcript-viewer.tsx`
- `components/episodes/audio-player.tsx`
- `components/episodes/summary-editor.tsx`
- `components/episodes/episode-actions.tsx` (retry, re-transcribe, re-summarize)

**Settings** (`app/dashboard/settings/page.tsx`) — split into:
- `components/settings/qir-settings-form.tsx`
- `components/settings/corrections-table.tsx`

**QIR Builder** (`app/dashboard/generate/page.tsx`) — extract into:
- `components/qir/draft-list.tsx`
- `components/qir/report-viewer.tsx`
- `components/qir/entry-editor.tsx`
- `components/qir/export-actions.tsx`

**Transcribe worker** (`workers/transcribe.ts`) — extract into:
- `lib/ffmpeg.ts` (chunking + cleanup)
- `lib/groq.ts` (API calls + backoff)
- `lib/vtt.ts` (already exists but verify it's properly separated)
- `lib/corrections.ts` (already exists)