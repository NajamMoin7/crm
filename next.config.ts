import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  // Database drivers load native/optional modules at runtime; keep them out of the bundle.
  serverExternalPackages: ["mongodb", "mongodb-memory-server-core"],
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
