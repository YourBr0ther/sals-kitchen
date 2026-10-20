import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // stamped into the service worker URL so each deploy gets a fresh cache
  env: { NEXT_PUBLIC_BUILD_ID: process.env.BUILD_ID || String(Date.now()) },
};

export default nextConfig;
