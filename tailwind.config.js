/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        primary: '#2563eb',
        'primary-light': '#eff6ff',
        success: '#10b981',
        violet: '#8b5cf6',
        amber: '#f59e0b',
      },
    },
  },
  plugins: [],
};
