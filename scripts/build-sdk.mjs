#!/usr/bin/env node
/**
 * Builds the vendored @proof/trading-sdk (git submodule at vendor/trading-sdk)
 * to dist/. Runs on `postinstall` so the SDK is ready locally and on Vercel.
 *
 * - Tolerant when the submodule isn't checked out (fresh clone without
 *   --recurse-submodules): prints guidance and exits 0 so install doesn't fail.
 * - Skips rebuild if dist/index.js already exists (submodule is pinned).
 *   Force a rebuild with: `rm -rf vendor/trading-sdk/dist && pnpm build:sdk`
 */
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const sdkDir = path.resolve("vendor/trading-sdk");

if (!existsSync(path.join(sdkDir, "package.json"))) {
  console.warn(
    "[build-sdk] vendor/trading-sdk is not checked out.\n" +
      "[build-sdk] Run: git submodule update --init --recursive",
  );
  process.exit(0);
}

if (existsSync(path.join(sdkDir, "dist", "index.js"))) {
  console.log("[build-sdk] @proof/trading-sdk already built — skipping.");
  process.exit(0);
}

try {
  console.log("[build-sdk] installing SDK dependencies…");
  execSync("npm install --no-audit --no-fund --loglevel=error", {
    cwd: sdkDir,
    stdio: "inherit",
  });
  console.log("[build-sdk] building SDK (tsc → dist/)…");
  execSync("npm run build", { cwd: sdkDir, stdio: "inherit" });
  console.log("[build-sdk] done.");
} catch (err) {
  console.error("[build-sdk] failed to build @proof/trading-sdk:", err.message);
  process.exit(1);
}
