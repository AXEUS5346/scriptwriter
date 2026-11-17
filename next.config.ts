import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  output: "standalone", // self-contained server for the packaged exe
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ["onnxruntime-node"], // native binding must not be bundled
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
