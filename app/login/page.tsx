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
    <div className="min-h-screen flex items-center justify-center bg-warm-50">
      <div className="w-full max-w-sm animate-fade-in">
        <div className="bg-white rounded-xl border border-warm-200 shadow-card p-8">
          <div className="flex justify-center mb-4">
            <div className="h-12 w-12 rounded-xl bg-kpfk-red flex items-center justify-center shadow-glow-red">
              <span className="text-white text-lg font-bold">Q</span>
            </div>
          </div>
          <h1 className="text-xl font-bold text-center mb-1 text-warm-900">QIR / KPFK</h1>
          <p className="text-sm text-warm-500 text-center mb-1">Quarterly Issues Report Dashboard</p>
          <p className="text-xs text-warm-400 text-center mb-6">Welcome back! Sign in to manage your FCC reports.</p>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-warm-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border border-warm-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-kpfk-red/20 focus:border-kpfk-red transition-colors bg-warm-50"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-warm-700 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-warm-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-kpfk-red/20 focus:border-kpfk-red transition-colors bg-warm-50"
                required
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-warm-800 text-white rounded-lg py-2.5 text-sm font-medium hover:bg-warm-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
