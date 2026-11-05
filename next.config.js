/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // The app never uses next/image, so turn the optimizer off entirely. This
  // disables the /_next/image endpoint, which is where the unpatched-in-14.x
  // image-optimizer RCE/DoS advisories live (see npm audit on next@14.2.35).
  images: { unoptimized: true },
  async redirects() {
    return [
      {
        // Legacy KPFK-implicit report URLs (e.g. /2025/q1) permanently redirect
        // to the station-slugged path. KPFK is the legacy station; filed FCC
        // report links point here and must keep resolving. The 4-digit year
        // constraint keeps this from matching station-slugged paths like /kpfk/.
        source: '/:year(\\d{4})/q:quarter(\\d+)',
        destination: '/kpfk/:year/q:quarter',
        permanent: true,
      },
    ]
  },
}

module.exports = nextConfig
