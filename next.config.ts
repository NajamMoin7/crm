import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  // PGlite ships WASM + data files resolved relative to the package; keep it out of the bundle.
  serverExternalPackages: ["@electric-sql/pglite"],
  poweredByHeader: false,
  // Old URL: accounts are managed on the Agents page.
  redirects: async () => [{ source: "/admin/users/:path*", destination: "/admin/agents/:path*", permanent: false }],
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
