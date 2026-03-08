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
          'red-light': '#D94A5E',
          'red-dark': '#9E1830',
          black: '#1a1a1a',
          gold: '#D4A843',
          'gold-light': '#E8C97A',
          'gold-dark': '#B08A2E',
          cream: '#FAF8F5',
          'cream-dark': '#F0EDE7',
        },
        // Warm-toned neutrals (slightly warm, not blue-gray)
        warm: {
          50: '#FAF9F7',
          100: '#F5F3F0',
          200: '#E8E5E0',
          300: '#D4D0C9',
          400: '#A8A39B',
          500: '#7D7870',
          600: '#5C574F',
          700: '#3F3B35',
          800: '#2A2722',
          900: '#1C1A17',
          950: '#0F0E0C',
        },
        // Sidebar dark palette
        sidebar: {
          bg: '#191817',
          hover: '#2A2722',
          active: '#352F28',
          border: '#3F3B35',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
      },
      borderRadius: {
        'xl': '0.875rem',
        '2xl': '1rem',
      },
      boxShadow: {
        'card': '0 1px 3px 0 rgba(0,0,0,0.04), 0 1px 2px -1px rgba(0,0,0,0.03)',
        'card-hover': '0 4px 6px -1px rgba(0,0,0,0.06), 0 2px 4px -2px rgba(0,0,0,0.04)',
        'glow-red': '0 0 0 3px rgba(196, 30, 58, 0.1)',
        'glow-gold': '0 0 0 3px rgba(212, 168, 67, 0.15)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-in-left': 'slideInLeft 0.25s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideInLeft: {
          '0%': { opacity: '0', transform: 'translateX(-12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
}
export default config
