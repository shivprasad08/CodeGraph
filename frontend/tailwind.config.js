/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: "#0a0a0f", secondary: "#111118" },
        surface: { DEFAULT: "#111118", hover: "#16161f" },
        border: { DEFAULT: "#1e1e2e", bright: "#2a2a3e" },
        accent: { DEFAULT: "#7c3aed", light: "#9d5ff0", dim: "#5b21b6" },
        success: "#22c55e",
        warning: "#f59e0b",
        error: "#ef4444",
        muted: "#6b7280",
        node: {
          file: "#3b82f6",
          function: "#7c3aed",
          class: "#f59e0b",
          entry: "#22c55e"
        }
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"]
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "fade-in": "fadeIn 0.3s ease-in-out",
        "slide-up": "slideUp 0.4s ease-out",
        "shimmer": "shimmer 1.5s infinite"
      },
      keyframes: {
        fadeIn: {
          from: { opacity: 0 },
          to: { opacity: 1 }
        },
        slideUp: {
          from: { opacity: 0, transform: 'translateY(8px)' },
          to: { opacity: 1, transform: 'translateY(0)' }
        },
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" }
        }
      }
    },
  },
  plugins: [],
}
