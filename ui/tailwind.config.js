/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Brand stays the same — single accent color across the app.
        brand: {
          DEFAULT: '#4338ca',
          50: '#eef2ff',
          100: '#e0e7ff',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
        },
        // Semantic palette — brand + 4 semantic + neutral (slate). All other
        // accent hues (violet, sky, rose, fuchsia, cyan, indigo-as-not-brand)
        // were retired in the §4 polish pass. When you reach for color, pick
        // from these tokens — never `bg-purple-100` etc.
        good: {
          50: '#ecfdf5', // emerald-50
          100: '#d1fae5', // emerald-100
          500: '#10b981', // emerald-500 — the dot color
          600: '#059669', // emerald-600
          700: '#047857', // emerald-700
        },
        warn: {
          50: '#fffbeb', // amber-50
          100: '#fef3c7', // amber-100
          500: '#f59e0b', // amber-500 — the dot color
          600: '#d97706', // amber-600
          700: '#b45309', // amber-700
        },
        bad: {
          50: '#fef2f2', // red-50
          100: '#fee2e2', // red-100
          500: '#ef4444', // red-500 — the dot color
          600: '#dc2626', // red-600
          700: '#b91c1c', // red-700
        },
        // `neutral` here intentionally aliases slate so existing slate-*
        // classes continue to work; new code that wants to telegraph
        // "neutral semantic" can use `neutral-*` for clarity.
        neutral: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
        },
      },
    },
  },
  plugins: [],
};
