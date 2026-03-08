import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        kpfk: {
          red: '#C41E3A',
          black: '#1a1a1a',
          gold: '#D4A843',
          cream: '#FAF8F5',
        },
      },
    },
  },
  plugins: [],
}
export default config
