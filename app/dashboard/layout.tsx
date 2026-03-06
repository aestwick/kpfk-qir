export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex">
      <nav className="w-56 bg-gray-900 text-gray-100 p-4 flex flex-col gap-1">
        <h1 className="text-lg font-bold mb-4 px-2">QIR / KPFK</h1>
        <a href="/dashboard" className="px-2 py-1.5 rounded hover:bg-gray-800">Overview</a>
        <a href="/dashboard/episodes" className="px-2 py-1.5 rounded hover:bg-gray-800">Episodes</a>
        <a href="/dashboard/jobs" className="px-2 py-1.5 rounded hover:bg-gray-800">Jobs</a>
        <a href="/dashboard/usage" className="px-2 py-1.5 rounded hover:bg-gray-800">Usage</a>
        <a href="/dashboard/generate" className="px-2 py-1.5 rounded hover:bg-gray-800">Generate QIR</a>
        <a href="/dashboard/downloads" className="px-2 py-1.5 rounded hover:bg-gray-800">Downloads</a>
        <a href="/dashboard/settings" className="px-2 py-1.5 rounded hover:bg-gray-800">Settings</a>
      </nav>
      <main className="flex-1 p-6">{children}</main>
    </div>
  )
}
