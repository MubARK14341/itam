import type { Config } from "tailwindcss";

// Studio workspace. Runtime semantic tokens live in src/app/globals.css.
// Neutral and status ramps are re-tuned here so every existing utility (slate-*, emerald-*, …)
// renders in the approved palette; new code should prefer the semantic names below.
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

// Studio cool neutrals. Existing light/dark utilities remain compatibility aliases.
const stone = {
  50: "#F8FAFC",
  100: "#EDF2F7",
  200: "#E5EAF0",
  300: "#CDD9E6",
  400: v("slate-400"),
  500: v("slate-500"),
  600: "#536B84",
  700: "#35485F",
  800: "#22364C",
  900: "#1C2D41",
  950: "#101B29",
};
// Compatibility status ramps; semantic status tokens own new components.
const ok = { 50: "#EDF7F1", 100: "#E3F3E9", 200: "#C3E5CF", 300: "#8FD0A8", 400: "#52B27A", 500: "#22904F", 600: "#177A44", 700: "#136C3E", 800: "#0F5431", 900: "#0C4227", 950: "#062816" };
const warn = { 50: "#FDF6E7", 100: "#FBEFD6", 200: "#F5DCA6", 300: "#EDC270", 400: "#E0A33D", 500: "#C9861B", 600: "#A86A08", 700: "#8A5300", 800: "#6E4200", 900: "#573400", 950: "#331E00" };
const bad = { 50: "#FDF1EF", 100: "#FCEAE8", 200: "#F7CFCA", 300: "#F0A69E", 400: "#E5776C", 500: "#D14B3F", 600: "#C0352A", 700: "#B3261E", 800: "#8F1E18", 900: "#701813", 950: "#420C09" };
const res = { 50: "#F2F6FF", 100: "#EAF0FD", 200: "#CDDDFB", 300: "#ABC4F5", 400: "#82A4EC", 500: "#557AD7", 600: "#315CC6", 700: "#264CAB", 800: "#23418D", 900: "#213968", 950: "#142442" };
const blue = res;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  // Chip tones are composed at runtime (`tone-${tone}` in src/lib/tone.ts), so the scanner cannot see them.
  safelist: ["tone-ok", "tone-res", "tone-warn", "tone-bad", "tone-info", "tone-neu"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans Arabic"', "system-ui", "sans-serif"],
        display: ['"IBM Plex Sans Arabic"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      colors: {
        slate: stone,
        gray: stone,
        emerald: ok,
        green: ok,
        amber: warn,
        yellow: warn,
        orange: warn,
        rose: bad,
        red: bad,
        indigo: res,
        violet: res,
        purple: res,
        fuchsia: res,
        blue,
        sky: blue,
        cyan: blue,
        teal: blue,
        // Semantic surfaces (flip with html.dark).
        canvas: v("canvas"),
        nav: { DEFAULT: v("nav"), fg: v("nav-ink"), muted: v("nav-muted"), line: v("nav-line") },
        surface: { DEFAULT: v("surface"), 2: v("surface-2") },
        sunk: v("sunk"),
        line: { DEFAULT: v("line"), strong: v("line-2") },
        muted: v("muted"),
        ink: { DEFAULT: "#172435", 2: v("ink-2"), soft: "#172435", muted: "#536B84" },
        fg: { DEFAULT: v("ink"), 2: v("ink-2") },
        brand: { DEFAULT: v("brand"), hover: v("brand-hover"), soft: v("brand-soft"), ink: v("brand-ink"), 2: v("brand-2"), on: v("on-brand") },
        ok: { DEFAULT: v("ok"), soft: v("ok-soft") },
        res: { DEFAULT: v("res"), soft: v("res-soft") },
        warn: { DEFAULT: v("warn"), soft: v("warn-soft") },
        bad: { DEFAULT: v("bad"), soft: v("bad-soft") },
        // Backwards-compatible aliases used across existing screens.
        secondary: { DEFAULT: v("brand-ink"), hover: v("brand-ink") },
        accent: { DEFAULT: v("brand"), hover: v("brand-hover"), soft: v("brand-soft") },
        success: { DEFAULT: v("ok"), hover: v("ok"), soft: v("ok-soft") },
        warning: { DEFAULT: v("warn"), hover: v("warn"), soft: v("warn-soft") },
        danger: { DEFAULT: v("bad"), hover: v("bad"), soft: v("bad-soft") },
        info: { DEFAULT: v("res"), hover: v("res"), soft: v("res-soft") },
      },
      borderRadius: {
        control: "10px",
        card: "16px",
      },
      boxShadow: {
        card: "0 2px 8px -4px rgb(23 36 53 / 0.06)",
        "card-hover": "0 4px 16px -8px rgb(23 36 53 / 0.12)",
        modal: "var(--shadow-pop)",
        pop: "0 1px 2px rgb(0 0 0 / 0.08), 0 0 0 1px rgb(var(--line))",
      },
      // Calm motion: 160–220ms ease-out; disabled by prefers-reduced-motion (globals.css).
      keyframes: {
        "fade-in": { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        "fade-in-up": { "0%": { opacity: "0", transform: "translateY(6px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
        "scale-in": { "0%": { opacity: "0", transform: "scale(0.98)" }, "100%": { opacity: "1", transform: "scale(1)" } },
        "sheet-in": { "0%": { opacity: "0", transform: "translateY(16px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
      },
      animation: {
        "fade-in": "fade-in 200ms ease-out both",
        "fade-in-up": "fade-in-up 220ms ease-out both",
        "scale-in": "scale-in 160ms ease-out both",
        "sheet-in": "sheet-in 220ms ease-out both",
      },
    },
  },
  plugins: [],
};
export default config;
