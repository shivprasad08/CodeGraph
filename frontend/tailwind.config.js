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
        },
        // Design-system tokens (src/styles/tokens.css), namespaced to avoid collisions
        cg: {
          canvas: "var(--cg-canvas)",
          raised: "var(--cg-raised)",
          overlay: "var(--cg-overlay)",
          hover: "var(--cg-hover)",
          border: "var(--cg-border)",
          "border-strong": "var(--cg-border-strong)",
          text: "var(--cg-text)",
          secondary: "var(--cg-text-secondary)",
          tertiary: "var(--cg-text-tertiary)",
          primary: { DEFAULT: "var(--cg-primary)", hover: "var(--cg-primary-hover)" },
          "on-primary": "var(--cg-on-primary)",
          focus: "var(--cg-focus)",
          node: {
            file: "var(--cg-node-file)",
            function: "var(--cg-node-function)",
            class: "var(--cg-node-class)",
            entry: "var(--cg-node-entry)"
          },
          sev: {
            high: "var(--cg-sev-high)",
            med: "var(--cg-sev-med)",
            low: "var(--cg-sev-low)"
          },
          success: "var(--cg-success)"
        }
      },
      borderRadius: {
        "cg-control": "var(--cg-radius-control)",
        "cg-panel": "var(--cg-radius-panel)"
      },
      boxShadow: {
        "cg-edge": "var(--cg-edge-highlight)"
      },
      fontSize: {
        "cg-xs": ["12px", { lineHeight: "16px" }],
        "cg-sm": ["13px", { lineHeight: "20px" }],
        "cg-base": ["15px", { lineHeight: "24px" }],
        "cg-lg": ["17px", { lineHeight: "26px" }],
        "cg-xl": ["20px", { lineHeight: "28px" }],
        "cg-2xl": ["28px", { lineHeight: "34px", letterSpacing: "-0.01em" }],
        "cg-display": ["48px", { lineHeight: "52px", letterSpacing: "-0.02em", fontWeight: "600" }]
      },
      transitionDuration: {
        "cg-fast": "var(--cg-dur-fast)",
        "cg-base": "var(--cg-dur-base)"
      },
      transitionTimingFunction: {
        cg: "var(--cg-ease)"
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"],
        "cg-sans": "var(--cg-font-sans)",
        "cg-mono": "var(--cg-font-mono)"
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "fade-in": "fadeIn 0.3s ease-in-out",
        "slide-up": "slideUp 0.4s ease-out",
        "shimmer": "shimmer 1.5s infinite",
        "cg-fade-in": "cgFadeIn var(--cg-dur-base) var(--cg-ease)",
        "cg-scale-in": "cgScaleIn var(--cg-dur-base) var(--cg-ease)"
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
        },
        cgFadeIn: {
          from: { opacity: 0 },
          to: { opacity: 1 }
        },
        cgScaleIn: {
          from: { opacity: 0, transform: "translate(-50%, -50%) scale(0.98)" },
          to: { opacity: 1, transform: "translate(-50%, -50%) scale(1)" }
        }
      }
    },
  },
  plugins: [],
}
