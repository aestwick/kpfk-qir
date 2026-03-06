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
    <div className="bg-white rounded-lg shadow p-8 text-center">
      <p className="text-gray-400 text-4xl mb-3">&#8709;</p>
      <p className="text-lg text-gray-600 font-medium mb-1">{title}</p>
      {description && <p className="text-sm text-gray-500 mb-4">{description}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className="px-4 py-2 text-sm bg-gray-900 text-white rounded hover:bg-gray-800"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
