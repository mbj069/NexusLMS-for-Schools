import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Authenticated app: classic rendering model (per-route `dynamic` config).
     The new cacheComponents model is for highly-static sites. */
  cacheComponents: false,
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
