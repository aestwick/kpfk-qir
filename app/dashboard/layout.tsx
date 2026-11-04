'use client'

import { useEffect, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { usePathname } from 'next/navigation'
import { ErrorBoundary } from '@/app/components/error-boundary'
import { ToastProvider } from '@/app/components/toast'
import { StationSwitcher } from '@/app/components/station-switcher'
import { NavAccessProvider, useNavAccess } from '@/app/components/nav-access'
import { SidebarNav, useActiveNavItem } from '@/app/components/sidebar-nav'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [userEmail, setUserEmail] = useState('')
  const [userId, setUserId] = useState('')

  useEffect(() => {
    const supabase = createBrowserClient()
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        window.location.href = '/login'
        return
      }
      setAuthed(true)
      setUserEmail(session.user.email ?? '')
      setUserId(session.user.id)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        window.location.href = '/login'
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  if (authed === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-warm-50 dark:bg-surface">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 border-2 border-kpfk-red border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-warm-400 dark:text-warm-500">Loading...</span>
        </div>
      </div>
    )
  }

  return (
    <NavAccessProvider userId={userId}>
      <DashboardShell userEmail={userEmail}>{children}</DashboardShell>
    </NavAccessProvider>
  )
}

/** Sidebar + phone header + page frame. Menu contents come from lib/nav.ts. */
function DashboardShell({ userEmail, children }: { userEmail: string; children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const pathname = usePathname()
  const current = useActiveNavItem()
  const { active } = useNavAccess()

  useEffect(() => {
    setSidebarOpen(false)
  }, [pathname])

  // Phone drawer: Escape closes it, and the page behind doesn't scroll.
  useEffect(() => {
    if (!sidebarOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSidebarOpen(false) }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [sidebarOpen])

  async function handleLogout() {
    const supabase = createBrowserClient()
    // Record the logout while the session token is still valid, then sign out.
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) {
      await fetch('/api/audit/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action: 'auth.logout' }),
      }).catch(() => {})
    }
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  return (
    <div className="min-h-screen flex bg-warm-50 dark:bg-surface">
      {/* Mobile header */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-30 bg-sidebar-bg text-white flex items-center justify-between px-4 py-3 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-7 w-7 shrink-0 rounded-lg bg-kpfk-red flex items-center justify-center">
            <span className="text-white text-xs font-bold">Q</span>
          </div>
          <span className="min-w-0 leading-tight">
            <span className="block text-sm font-semibold tracking-tight truncate">{current?.label ?? 'QIR'}</span>
            {active && <span className="block text-2xs text-warm-400 truncate">{active.name}</span>}
          </span>
        </div>
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="p-1.5 rounded-lg hover:bg-sidebar-hover transition-colors"
          aria-label="Toggle menu"
          aria-expanded={sidebarOpen}
          aria-controls="dashboard-sidebar"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {sidebarOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
      </div>

      {/* Backdrop */}
      {sidebarOpen && (
        <div
          className="md:hidden fixed inset-0 z-30 bg-black/40 backdrop-blur-sm transition-opacity"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <nav id="dashboard-sidebar" aria-label="Main menu" className={`
        fixed md:sticky z-40 top-0 left-0 h-full md:h-screen w-60 bg-sidebar-bg text-warm-300 flex flex-col shrink-0
        transition-transform duration-250 ease-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        {/* Brand */}
        {/* Brand (the phone header already shows it, so the drawer skips it) */}
        <div className="hidden md:block px-5 pt-6 pb-5">
          <a href="/dashboard" className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-kpfk-red flex items-center justify-center shadow-glow-red">
              <span className="text-white text-sm font-bold">Q</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-white tracking-tight">QIR</p>
              <p className="text-2xs text-warm-500">Quarterly Issues Report</p>
            </div>
          </a>
        </div>

        {/* Active station (a switcher when the user has more than one) */}
        <div className="pt-5 md:pt-0">
          <StationSwitcher />
        </div>

        {/* Navigation — one definition in lib/nav.ts */}
        <SidebarNav />

        {/* User footer */}
        <div className="px-5 py-4 border-t border-sidebar-border">
          <p className="text-2xs text-warm-500 truncate mb-2">{userEmail}</p>
          <button
            onClick={handleLogout}
            className="text-2xs text-warm-500 hover:text-warm-200 transition-colors flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Sign Out
          </button>
        </div>
      </nav>

      <main className="flex-1 min-w-0 overflow-auto pt-16 md:pt-0">
        <div className="p-5 md:p-8">
          <ErrorBoundary>
            <ToastProvider>
              {children}
            </ToastProvider>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  )
}

