import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow importing the shared crawler modules used by the Cloudflare Worker.
  outputFileTracingIncludes: {
    "/**": ["./workers/crawler/**"],
  },
};

export default nextConfig;
