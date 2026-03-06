'use client'

import { useEffect, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { usePathname } from 'next/navigation'

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
  const pathname = usePathname()

  useEffect(() => {
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
  }, [])

  async function handleLogout() {
    const supabase = createBrowserClient()
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  if (authed === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex">
      <nav className="w-56 bg-gray-900 text-gray-100 p-4 flex flex-col shrink-0">
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
      <main className="flex-1 p-6 overflow-auto">{children}</main>
    </div>
  )
}
