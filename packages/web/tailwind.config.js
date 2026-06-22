/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    // Fixed rem scale, ratio ~1.2 (DESIGN.md). Dense UI sits at sm/base.
    fontSize: {
      xs: ["0.75rem", { lineHeight: "1rem" }],
      sm: ["0.8125rem", { lineHeight: "1.15rem" }],
      base: ["0.875rem", { lineHeight: "1.35rem" }],
      lg: ["1.0625rem", { lineHeight: "1.5rem" }],
      xl: ["1.375rem", { lineHeight: "1.75rem" }],
    },
    extend: {
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          '"Segoe UI"',
          "Roboto",
          "Inter",
          "sans-serif",
        ],
      },
      // Semantic names -> CSS custom properties (single-sourced in styles.css :root).
      // Lets us write bg-panel / text-ink / border-border / text-ok etc.
      colors: {
        surface: "var(--surface)",
        panel: "var(--panel)",
        rail: "var(--rail)",
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        ink: "var(--ink)",
        "ink-soft": "var(--ink-soft)",
        "ink-faint": "var(--ink-faint)",
        accent: "var(--accent)",
        "accent-ink": "var(--accent-ink)",
        "accent-soft": "var(--accent-soft)",
        ok: "var(--ok)",
        "ok-soft": "var(--ok-soft)",
        warn: "var(--warn)",
        "warn-soft": "var(--warn-soft)",
        bad: "var(--bad)",
        "bad-soft": "var(--bad-soft)",
        chaos: "var(--chaos)",
        "chaos-soft": "var(--chaos-soft)",
      },
      borderColor: {
        DEFAULT: "var(--border)",
      },
      ringColor: {
        DEFAULT: "var(--accent)",
      },
      borderRadius: {
        md: "6px",
      },
      keyframes: {
        "status-in": {
          from: { backgroundColor: "var(--flash, transparent)" },
          to: { backgroundColor: "transparent" },
        },
        "drawer-in": {
          from: { transform: "translateX(1.5rem)", opacity: "0" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        // 150-250ms ease-out only, for state/feedback/drawer.
        "status-in": "status-in 250ms cubic-bezier(0.22, 1, 0.36, 1)",
        "drawer-in": "drawer-in 200ms cubic-bezier(0.22, 1, 0.36, 1)",
        "fade-in": "fade-in 180ms cubic-bezier(0.22, 1, 0.36, 1)",
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
