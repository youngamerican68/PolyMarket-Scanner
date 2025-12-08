import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'poly-bg': '#0d0d0d',
        'poly-card': '#1a1a1a',
        'poly-border': '#2a2a2a',
        'poly-text': '#ffffff',
        'poly-muted': '#888888',
        'poly-green': '#00d26a',
        'poly-red': '#ff4757',
        'poly-yellow': '#ffc107',
        'poly-blue': '#4a9eff',
        'poly-purple': '#9b59b6',
      },
    },
  },
  plugins: [],
}
export default config
