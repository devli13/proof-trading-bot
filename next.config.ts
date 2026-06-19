import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Proof SDK (+ its @noble crypto deps) use ".js" deep imports that don't bundle
  // cleanly on Vercel's pnpm layout. Treat it as external so Node resolves it at runtime
  // (exactly like the worker), instead of webpack-bundling it.
  serverExternalPackages: ["@proof/trading-sdk", "@noble/hashes", "@noble/ed25519", "@noble/curves"],
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
