// next.config.ts routes every *.css through @tailwindcss/turbopack with `as: "*.css"`,
// which compiles even *.module.css files to plain, unhashed global css. Their default
// export is then an empty object, so `import styles from "./x.module.css"` yields no
// class names at runtime. The arc block stylesheets therefore ship as global css with
// every class prefixed `arc-`; this proxy mirrors the original `styles.x`/`styles[k]`
// accesses onto the prefixed global names ("panel" -> "arc-panel", case preserved),
// keeping the block sources untouched.
const cache = new Map<string, string>();

export const arcCls = new Proxy({} as Record<string, string>, {
  get(_, key) {
    if (typeof key !== "string") return "";
    let v = cache.get(key);
    if (!v) {
      v = "arc-" + key;
      cache.set(key, v);
    }
    return v;
  },
});
