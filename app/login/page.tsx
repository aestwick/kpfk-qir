'use client'

import { useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const supabase = createBrowserClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    window.location.href = '/dashboard'
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-warm-50 dark:bg-surface">
      <div className="w-full max-w-sm animate-fade-in">
        <div className="bg-white dark:bg-surface-raised rounded-xl border border-warm-200 dark:border-warm-700 shadow-card dark:shadow-card-dark p-8">
          <div className="flex justify-center mb-4">
            <div className="h-12 w-12 rounded-xl bg-kpfk-red flex items-center justify-center shadow-glow-red dark:shadow-glow-red-dark">
              <span className="text-white text-lg font-bold">Q</span>
            </div>
          </div>
          <h1 className="text-xl font-bold text-center mb-1 text-warm-900 dark:text-warm-50">QIR / KPFK</h1>
          <p className="text-sm text-warm-500 text-center mb-1 dark:text-warm-400">Quarterly Issues Report Dashboard</p>
          <p className="text-xs text-warm-400 text-center mb-6 dark:text-warm-500">Welcome back! Sign in to manage your FCC reports.</p>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-warm-700 dark:text-warm-300 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border border-warm-200 dark:border-warm-600 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-kpfk-red/20 dark:focus:ring-kpfk-red-light/30 focus:border-kpfk-red dark:focus:border-kpfk-red-light transition-colors bg-warm-50 dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-warm-700 dark:text-warm-300 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-warm-200 dark:border-warm-600 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-kpfk-red/20 dark:focus:ring-kpfk-red-light/30 focus:border-kpfk-red dark:focus:border-kpfk-red-light transition-colors bg-warm-50 dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
                required
              />
            </div>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-warm-800 text-white dark:bg-warm-200 dark:text-warm-900 rounded-lg py-2.5 text-sm font-medium hover:bg-warm-700 dark:hover:bg-warm-100 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
