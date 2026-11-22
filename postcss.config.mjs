// Tailwind v4 through the standard PostCSS pipeline.
// The app used to rely on next.config.ts `turbopack.rules` mapping *.css to
// @tailwindcss/turbopack, which webpack builds ignore - the stylesheet came out
// with preflight only and every page rendered unstyled.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
