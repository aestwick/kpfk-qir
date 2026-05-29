/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
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
