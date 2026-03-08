'use client'

import { createContext, useContext, useState, useCallback, useEffect } from 'react'

interface Toast {
  id: number
  type: 'success' | 'error'
  message: string
}

interface ToastContextValue {
  toast: (type: 'success' | 'error', message: string) => void
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} })

export function useToast() {
  return useContext(ToastContext)
}

let nextId = 0

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const toast = useCallback((type: 'success' | 'error', message: string) => {
    const id = ++nextId
    setToasts((prev) => [...prev, { id, type, message }])
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), 5000)
    return () => clearTimeout(timer)
  }, [toast.id, onDismiss])

  const colors = toast.type === 'success'
    ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200 dark:border-emerald-700/50'
    : 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-200 dark:border-red-700/50'

  return (
    <div className={`${colors} border rounded-xl px-4 py-3 text-sm shadow-lg flex items-center justify-between gap-3 animate-slide-up`}>
      <span>{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        className="text-current opacity-50 hover:opacity-100 text-xs shrink-0"
      >
        Dismiss
      </button>
    </div>
  )
}
