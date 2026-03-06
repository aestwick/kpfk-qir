import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'QIR — KPFK 90.7FM',
  description: 'Quarterly Issues Report automation for KPFK',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 antialiased">{children}</body>
    </html>
  )
}
