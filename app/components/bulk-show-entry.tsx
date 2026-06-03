'use client'

import { useMemo, useState } from 'react'
import { authedFetch } from '@/lib/api-client'

interface DraftRow {
  show_name: string
  key: string
  category: string          // iTunes feed category, e.g. "News & Politics"
  primary_language: string  // ISO 639-1; blank = soft default English (stored null)
}

// Left blank by default: an unset language is a soft default to English (the row
// is stored with primary_language null and resolves to English at read time), so
// staff only pick a language for shows that air in something other than English.
const EMPTY_ROW: DraftRow = { show_name: '', key: '', category: '', primary_language: '' }

// Classic iTunes / Apple Podcasts top-level categories (the taxonomy KPFK's
// archive feeds use, e.g. <itunes:category text="News & Politics"/>). Free text
// is still allowed — this just powers the autocomplete datalist.
const ITUNES_CATEGORIES = [
  'Arts', 'Business', 'Comedy', 'Education', 'Games & Hobbies',
  'Government & Organizations', 'Health', 'Kids & Family', 'Music',
  'News & Politics', 'Religion & Spirituality', 'Science & Medicine',
  'Society & Culture', 'Sports & Recreation', 'Technology', 'TV & Film',
]

// Languages offered in the dropdown (KPFK / Pacifica programming).
const LANGUAGE_OPTIONS: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'hy', label: 'Armenian' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
  { code: 'fa', label: 'Persian' },
  { code: 'ru', label: 'Russian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ar', label: 'Arabic' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'tl', label: 'Tagalog' },
]

function isHeaderRow(cells: string[]): boolean {
  return cells.some((c) => /^(show ?name|name|show ?key|key|category|cat|primary ?language|language|lang)$/i.test(c.trim()))
}

// Parse a pasted table. Splits on tab (preferred — spreadsheet copy) or comma,
// one row per line. Column order: name, key, category, language. A missing or
// blank language column is left blank — a soft default to English.
function parsePaste(text: string): DraftRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '')
  const rows = lines.map((line) => (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim()))
  if (rows.length && isHeaderRow(rows[0])) rows.shift()
  return rows.map((cells) => ({
    show_name: cells[0] ?? '',
    key: cells[1] ?? '',
    category: cells[2] ?? '',
    primary_language: (cells[3] ?? '').trim(),
  }))
}

// A row is "empty" for grid bookkeeping if it has no name, key, or category.
// Language is ignored here — a blank language is a valid soft default (English).
const rowIsEmpty = (r: DraftRow) => !r.show_name.trim() && !r.key.trim() && !r.category.trim()
const rowIsValid = (r: DraftRow) => !!r.show_name.trim() && !!r.key.trim()

/* ─── Checklist of programs discovered from the station's archive ─── */
function DiscoverChecklist({
  discovered,
  selected,
  setSelected,
  existingSet,
  resolving,
  onAdd,
  onCancel,
}: {
  discovered: { key: string; name: string }[]
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  existingSet: Set<string>
  resolving: boolean
  onAdd: () => void
  onCancel: () => void
}) {
  const newOnes = discovered.filter((s) => !existingSet.has(s.key.toLowerCase()))

  function toggle(key: string) {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSelected(next)
  }

  return (
    <div className="border dark:border-warm-600 rounded p-3 space-y-2 bg-white dark:bg-warm-800">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm font-medium">
          {discovered.length} program{discovered.length === 1 ? '' : 's'} found · {newOnes.length} new · {selected.size} selected
        </p>
        <div className="flex items-center gap-2 text-xs">
          <button onClick={() => setSelected(new Set(newOnes.map((s) => s.key)))} className="text-blue-600 dark:text-blue-400 hover:underline">
            Select all new
          </button>
          <button onClick={() => setSelected(new Set(discovered.map((s) => s.key)))} className="text-blue-600 dark:text-blue-400 hover:underline">
            Select all
          </button>
          <button onClick={() => setSelected(new Set())} className="text-gray-500 dark:text-warm-400 hover:underline">
            Clear
          </button>
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto border dark:border-warm-600 rounded divide-y dark:divide-warm-600/50">
        {discovered.map((s) => {
          const exists = existingSet.has(s.key.toLowerCase())
          return (
            <label key={s.key} className="flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-warm-700">
              <input type="checkbox" checked={selected.has(s.key)} onChange={() => toggle(s.key)} className="shrink-0" />
              <span className="flex-1 truncate">{s.name}</span>
              <span className="font-mono text-xs text-gray-400 dark:text-warm-500 shrink-0">{s.key}</span>
              {exists && <span className="text-xs text-blue-600 dark:text-blue-400 shrink-0" title="Already a show — will update">exists</span>}
            </label>
          )
        })}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onAdd}
          disabled={resolving || selected.size === 0}
          className="px-4 py-1.5 text-sm bg-green-600 dark:bg-green-700 text-white rounded hover:bg-green-700 dark:hover:bg-green-600 disabled:opacity-40"
        >
          {resolving ? 'Looking up…' : `Add ${selected.size || ''} selected`.trim()}
        </button>
        <button onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-900 dark:text-warm-400 dark:hover:text-warm-200">
          Cancel
        </button>
        <span className="text-xs text-gray-500 dark:text-warm-400">Looks up name + category from each feed, then loads them below to review.</span>
      </div>
    </div>
  )
}

/* ─── Fast bulk entry for show keys (grid typing or paste) ─── */
export function BulkShowEntry({
  existingKeys,
  onAdded,
  toast,
}: {
  existingKeys: string[]            // existing show keys for this station (for new/update badges)
  onAdded: () => void               // refresh the parent shows list after a successful save
  toast: (type: 'success' | 'error', msg: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<DraftRow[]>([{ ...EMPTY_ROW }])
  const [pasteText, setPasteText] = useState('')
  const [saving, setSaving] = useState(false)
  const [keysText, setKeysText] = useState('')
  const [resolving, setResolving] = useState(false)
  const [discovered, setDiscovered] = useState<{ key: string; name: string }[] | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const existingSet = useMemo(() => new Set(existingKeys.map((k) => k.trim().toLowerCase())), [existingKeys])

  const validRows = rows.filter(rowIsValid)
  const newCount = validRows.filter((r) => !existingSet.has(r.key.trim().toLowerCase())).length
  const updateCount = validRows.length - newCount

  // Update a cell; keep a single trailing empty row so Tab always lands somewhere new.
  function updateCell(index: number, field: keyof DraftRow, value: string) {
    setRows((prev) => {
      const next = prev.map((r, i) => (i === index ? { ...r, [field]: value } : r))
      if (index === next.length - 1 && !rowIsEmpty(next[index])) next.push({ ...EMPTY_ROW })
      return next
    })
  }

  function removeRow(index: number) {
    setRows((prev) => {
      const next = prev.filter((_, i) => i !== index)
      return next.length ? next : [{ ...EMPTY_ROW }]
    })
  }

  function loadParsed(parsed: DraftRow[]) {
    // Merge onto any rows already typed (drop the trailing empty), then re-add one.
    setRows((prev) => [...prev.filter((r) => !rowIsEmpty(r)), ...parsed, { ...EMPTY_ROW }])
    toast('success', `Loaded ${parsed.length} row${parsed.length === 1 ? '' : 's'} — review and save`)
  }

  function loadPaste() {
    const parsed = parsePaste(pasteText)
    if (parsed.length === 0) {
      toast('error', 'Nothing to load — paste rows of: name, key, category, language')
      return
    }
    loadParsed(parsed)
    setPasteText('')
  }

  // Resolve a list of bare show keys against the station's archive feeds, filling
  // in name + category from each live feed, then load the results into the grid.
  // Keys that don't resolve are still added (key only) so they show as "incomplete"
  // rather than vanishing silently. The resolve endpoint caps at 100 keys/request,
  // so chunk to support discovering a whole station at once. Returns false on error.
  async function resolveAndLoad(rawKeys: string[]): Promise<boolean> {
    const keys = Array.from(new Set(rawKeys.map((k) => k.trim()).filter(Boolean)))
    if (keys.length === 0) {
      toast('error', 'No show keys to look up')
      return false
    }
    setResolving(true)
    try {
      const results: { key: string; feed_name: string | null; category: string | null; ok: boolean }[] = []
      for (let i = 0; i < keys.length; i += 100) {
        const res = await authedFetch('/api/shows/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: keys.slice(i, i + 100) }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast('error', data.error ?? 'Lookup failed')
          return false
        }
        results.push(...(data.results ?? []))
      }
      loadParsed(
        results.map((r) => ({
          show_name: r.feed_name ?? '',
          key: r.key,
          category: r.category ?? '',
          primary_language: '',
        }))
      )
      const found = results.filter((r) => r.ok).length
      const failed = results.length - found
      toast(
        failed ? 'error' : 'success',
        `Looked up ${found} feed${found === 1 ? '' : 's'}${failed ? `, ${failed} not found (left blank — review or remove)` : ''}`
      )
      return true
    } catch {
      toast('error', 'Network error')
      return false
    } finally {
      setResolving(false)
    }
  }

  async function lookupKeys() {
    const keys = keysText.split(/\r?\n/).flatMap((l) => l.split(',')).map((k) => k.trim()).filter(Boolean)
    if (keys.length === 0) {
      toast('error', 'Paste at least one show key (one per line)')
      return
    }
    if (await resolveAndLoad(keys)) setKeysText('')
  }

  // Fetch the station's full program list from its archive home page and show it
  // as a checklist. New keys (not already saved) are pre-selected.
  async function discover() {
    setDiscovering(true)
    try {
      const res = await authedFetch('/api/shows/discover')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast('error', data.error ?? 'Discovery failed')
        return
      }
      const shows: { key: string; name: string }[] = data.shows ?? []
      setDiscovered(shows)
      setSelected(new Set(shows.filter((s) => !existingSet.has(s.key.toLowerCase())).map((s) => s.key)))
      toast('success', `Found ${shows.length} program${shows.length === 1 ? '' : 's'} — pick which to add`)
    } catch {
      toast('error', 'Network error')
    }
    setDiscovering(false)
  }

  // Resolve the checked programs (name + category from each feed) into the grid.
  async function addSelectedDiscovered() {
    if (selected.size === 0) {
      toast('error', 'Select at least one program')
      return
    }
    if (await resolveAndLoad(Array.from(selected))) {
      setDiscovered(null)
      setSelected(new Set())
    }
  }

  async function save() {
    if (validRows.length === 0) {
      toast('error', 'Add at least one row with a name and key')
      return
    }
    setSaving(true)
    try {
      const res = await authedFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: 'shows', shows: validRows }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        toast('success', `Saved ${data.count ?? validRows.length} show${(data.count ?? validRows.length) === 1 ? '' : 's'}`)
        setRows([{ ...EMPTY_ROW }])
        setPasteText('')
        onAdded()
      } else {
        toast('error', data.error ?? 'Failed to save shows')
      }
    } catch {
      toast('error', 'Network error')
    }
    setSaving(false)
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-sm bg-gray-900 dark:bg-warm-100 text-white dark:text-warm-900 rounded hover:bg-gray-700 dark:hover:bg-warm-200"
      >
        + Add shows
      </button>
    )
  }

  return (
    <div className="border dark:border-warm-600 rounded p-3 space-y-3 bg-gray-50 dark:bg-warm-700">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Add shows — type and press Tab to move across, or paste a table</p>
        <button
          onClick={() => { setOpen(false); setRows([{ ...EMPTY_ROW }]); setPasteText(''); setKeysText(''); setDiscovered(null); setSelected(new Set()) }}
          className="text-xs text-gray-500 hover:text-gray-900 dark:text-warm-400 dark:hover:text-warm-200"
        >
          Close
        </button>
      </div>

      {/* Discover from archive: enumerate every program for this station */}
      <div className="flex items-center gap-3">
        <button
          onClick={discover}
          disabled={discovering || resolving}
          className="px-3 py-1.5 text-sm bg-purple-600 dark:bg-purple-700 text-white rounded hover:bg-purple-700 dark:hover:bg-purple-600 disabled:opacity-40"
        >
          {discovering ? 'Discovering…' : '🔍 Discover from archive'}
        </button>
        <span className="text-xs text-gray-500 dark:text-warm-400">
          Pull the station&apos;s full program list, then pick which shows to add.
        </span>
      </div>

      {discovered && (
        <DiscoverChecklist
          discovered={discovered}
          selected={selected}
          setSelected={setSelected}
          existingSet={existingSet}
          resolving={resolving}
          onAdd={addSelectedDiscovered}
          onCancel={() => { setDiscovered(null); setSelected(new Set()) }}
        />
      )}

      {/* Paste loader */}
      <div className="space-y-1.5">
        <label className="text-xs text-gray-500 dark:text-warm-400">
          Paste from a spreadsheet (columns: name, key, category, language — tab or comma separated). Language defaults to English.
        </label>
        <div className="flex gap-2">
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            onPaste={(e) => {
              // If the field is empty, parse the paste straight into the grid.
              if (pasteText.trim() === '') {
                const text = e.clipboardData.getData('text')
                if (text.includes('\n') || text.includes('\t')) {
                  e.preventDefault()
                  const parsed = parsePaste(text)
                  if (parsed.length) loadParsed(parsed)
                }
              }
            }}
            placeholder={'Democracy Now!\tdn9\tNews & Politics\ten\nUprising\tuprising\tNews & Politics'}
            rows={2}
            className="flex-1 border dark:border-warm-600 rounded px-2 py-1.5 text-sm font-mono dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
          />
          <button
            onClick={loadPaste}
            disabled={!pasteText.trim()}
            className="px-3 py-1.5 text-sm self-start bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-40"
          >
            Load
          </button>
        </div>
      </div>

      {/* Keys-only lookup: fetch name + category from the station's archive feeds */}
      <div className="space-y-1.5">
        <label className="text-xs text-gray-500 dark:text-warm-400">
          Have only the keys? Paste them (one per line) and look up each name + category from the station&apos;s archive feeds.
        </label>
        <div className="flex gap-2">
          <textarea
            value={keysText}
            onChange={(e) => setKeysText(e.target.value)}
            placeholder={'dn9\nuprising\nalterradioar'}
            rows={2}
            className="flex-1 border dark:border-warm-600 rounded px-2 py-1.5 text-sm font-mono dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
          />
          <button
            onClick={lookupKeys}
            disabled={!keysText.trim() || resolving}
            className="px-3 py-1.5 text-sm self-start bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-40 whitespace-nowrap"
          >
            {resolving ? 'Looking up…' : 'Look up'}
          </button>
        </div>
      </div>

      {/* Editable grid */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 dark:bg-warm-800 border-b dark:border-warm-600">
            <tr>
              <th className="text-left px-2 py-1.5 font-medium">Name</th>
              <th className="text-left px-2 py-1.5 font-medium">Key</th>
              <th className="text-left px-2 py-1.5 font-medium">Category</th>
              <th className="text-left px-2 py-1.5 font-medium">Language</th>
              <th className="px-2 py-1.5 w-24"></th>
              <th className="px-2 py-1.5 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const dup = row.key.trim() && existingSet.has(row.key.trim().toLowerCase())
              const incomplete = !rowIsEmpty(row) && !rowIsValid(row)
              return (
                <tr key={i} className="border-b dark:border-warm-600/50">
                  <td className="px-1 py-1">
                    <input
                      type="text"
                      value={row.show_name}
                      onChange={(e) => updateCell(i, 'show_name', e.target.value)}
                      placeholder="Show name"
                      className="w-full border dark:border-warm-600 rounded px-2 py-1 text-sm dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      type="text"
                      value={row.key}
                      onChange={(e) => updateCell(i, 'key', e.target.value)}
                      placeholder="feed key"
                      className="w-full border dark:border-warm-600 rounded px-2 py-1 text-sm font-mono dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      type="text"
                      list="bulk-show-categories"
                      value={row.category}
                      onChange={(e) => updateCell(i, 'category', e.target.value)}
                      placeholder="e.g. News & Politics"
                      className="w-full border dark:border-warm-600 rounded px-2 py-1 text-sm dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <div className="flex items-center gap-1">
                      <select
                        value={row.primary_language}
                        onChange={(e) => updateCell(i, 'primary_language', e.target.value)}
                        className="flex-1 border dark:border-warm-600 rounded px-2 py-1 text-sm dark:bg-warm-800 dark:text-warm-100"
                      >
                        <option value="">English (default)</option>
                        {LANGUAGE_OPTIONS.map((l) => (
                          <option key={l.code} value={l.code}>{l.label} ({l.code})</option>
                        ))}
                      </select>
                      {row.primary_language && (
                        <button
                          type="button"
                          onClick={() => updateCell(i, 'primary_language', '')}
                          className="text-gray-400 hover:text-red-600 dark:hover:text-red-400 px-1"
                          title="Clear language"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-1 py-1 text-center">
                    {incomplete ? (
                      <span className="text-xs text-amber-600 dark:text-amber-400" title="Needs both a name and a key to save">incomplete</span>
                    ) : dup ? (
                      <span className="text-xs text-blue-600 dark:text-blue-400" title="A show with this key already exists — saving will update it">updates</span>
                    ) : rowIsValid(row) ? (
                      <span className="text-xs text-green-600 dark:text-green-400">new</span>
                    ) : null}
                  </td>
                  <td className="px-1 py-1 text-center">
                    {!rowIsEmpty(row) && (
                      <button
                        onClick={() => removeRow(i)}
                        className="text-gray-400 hover:text-red-600 dark:hover:text-red-400 text-sm"
                        title="Remove row"
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <datalist id="bulk-show-categories">
          {ITUNES_CATEGORIES.map((c) => <option key={c} value={c} />)}
        </datalist>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || validRows.length === 0}
          className="px-4 py-1.5 text-sm bg-green-600 dark:bg-green-700 text-white rounded hover:bg-green-700 dark:hover:bg-green-600 disabled:opacity-40"
        >
          {saving ? 'Saving…' : `Save ${validRows.length || ''} show${validRows.length === 1 ? '' : 's'}`.trim()}
        </button>
        {validRows.length > 0 && (
          <span className="text-xs text-gray-500 dark:text-warm-400">
            {newCount} new{updateCount > 0 ? `, ${updateCount} update${updateCount === 1 ? '' : 's'}` : ''}
          </span>
        )}
      </div>
    </div>
  )
}
