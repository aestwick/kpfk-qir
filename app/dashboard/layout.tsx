'use client'

import { useEffect, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { usePathname } from 'next/navigation'
import { ErrorBoundary } from '@/app/components/error-boundary'

const navItems = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/episodes', label: 'Episodes' },
  { href: '/dashboard/jobs', label: 'Jobs' },
  { href: '/dashboard/usage', label: 'Usage' },
  { href: '/dashboard/generate', label: 'Generate QIR' },
  { href: '/dashboard/downloads', label: 'Downloads' },
  { href: '/dashboard/settings', label: 'Settings' },
]

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [userEmail, setUserEmail] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const pathname = usePathname()

  useEffect(() => {
    setSidebarOpen(false)
  }, [pathname])

  // TODO: Re-enable auth once end-to-end testing is complete
  // To restore: remove the early return below and uncomment the auth check
  useEffect(() => {
    // Auth bypass: skip session check for local/e2e testing
    setAuthed(true)
    setUserEmail('dev@test.local')
    return

    // Original auth logic — kept intact for re-enabling later
    /* eslint-disable no-unreachable */
    const supabase = createBrowserClient()
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        window.location.href = '/login'
        return
      }
      setAuthed(true)
      setUserEmail(session.user.email ?? '')
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        window.location.href = '/login'
      }
    })

    return () => subscription.unsubscribe()
    /* eslint-enable no-unreachable */
  }, [])

  async function handleLogout() {
    const supabase = createBrowserClient()
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  if (authed === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-pulse text-gray-400">Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex">
      {/* Mobile header */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-30 bg-gray-900 text-white flex items-center justify-between px-4 py-3">
        <h1 className="text-lg font-bold">QIR / KPFK</h1>
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="p-1 rounded hover:bg-gray-800"
          aria-label="Toggle menu"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
          className="md:hidden fixed inset-0 z-30 bg-black/50"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <nav className={`
        fixed md:static z-40 top-0 left-0 h-full w-56 bg-gray-900 text-gray-100 p-4 flex flex-col shrink-0
        transition-transform duration-200 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        <h1 className="text-lg font-bold mb-6 px-2">QIR / KPFK</h1>
        <div className="flex flex-col gap-0.5 flex-1">
          {navItems.map((item) => {
            const active = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
            return (
              <a
                key={item.href}
                href={item.href}
                className={`px-3 py-2 rounded text-sm ${
                  active ? 'bg-gray-700 text-white font-medium' : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                }`}
              >
                {item.label}
              </a>
            )
          })}
        </div>
        <div className="border-t border-gray-700 pt-3 mt-3">
          <p className="text-xs text-gray-400 px-2 truncate mb-2">{userEmail}</p>
          <button
            onClick={handleLogout}
            className="text-xs text-gray-400 hover:text-white px-2"
          >
            Sign Out
          </button>
        </div>
      </nav>

      <main className="flex-1 p-6 overflow-auto pt-16 md:pt-6">
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
      </main>
    </div>
  )
}
