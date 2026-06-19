import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dashboard API routes reuse the worker's src/ (and the vendored Proof SDK),
  // which use NodeNext-style ".js" import specifiers that resolve to ".ts" files.
  transpilePackages: ["@proof/trading-sdk"],
  // webpack's extensionAlias resolves the src/ ".js" specifiers to ".ts" (Turbopack
  // does not do this substitution). We build with `next build --webpack`.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
  async redirects() {
    return [{ source: "/dashboard", destination: "/", permanent: false }];
  },
};

export default nextConfig;
