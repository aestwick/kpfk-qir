'use client'

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="bg-white dark:bg-surface-raised rounded-xl border border-warm-200 dark:border-warm-700 shadow-card dark:shadow-card-dark p-8 text-center">
      <p className="text-warm-300 dark:text-warm-600 text-4xl mb-3">&#8709;</p>
      <p className="text-lg text-warm-600 dark:text-warm-300 font-medium mb-1">{title}</p>
      {description && <p className="text-sm text-warm-400 dark:text-warm-500 mb-4">{description}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className="px-4 py-2 text-sm bg-warm-800 text-white dark:bg-warm-200 dark:text-warm-900 rounded-lg hover:bg-warm-700 dark:hover:bg-warm-100 transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
