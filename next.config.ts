import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  output: "standalone", // self-contained server for the packaged exe
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ["onnxruntime-node"], // native binding must not be bundled
  // styles are compiled by @tailwindcss/postcss (postcss.config.mjs) for every
  // builder; the old turbopack-only css rule is gone so webpack builds the same
  // stylesheet Turbopack does
};

export default nextConfig;
