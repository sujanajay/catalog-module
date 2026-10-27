import path from "node:path";
import type { NextConfig } from "next";

// Standalone output copies pnpm's symlinked node_modules, which needs symlink rights. Windows without
// Developer Mode fails with EPERM, so local Windows builds skip it (set NEXT_STANDALONE=1 to force).
// Docker and CI (Linux) always build standalone.
const standalone = process.platform !== "win32" || process.env.NEXT_STANDALONE === "1";

const nextConfig: NextConfig = {
  output: standalone ? "standalone" : undefined,
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: ["@catalog/core"],
  // unzipper loads its optional S3 adapter lazily. Keep its actual Node package rather than
  // bundling that unused adapter and requiring an AWS SDK for our GCS-only archive reader.
  serverExternalPackages: ["pg", "@google-cloud/storage", "@google-cloud/tasks", "google-auth-library", "unzipper"],
  // @google-cloud/tasks and google-gax load client config and protos via dynamic paths that file
  // tracing cannot see; without these the standalone image fails on the first enqueue.
  outputFileTracingIncludes: {
    "/**": [
      "../../node_modules/.pnpm/@google-cloud+tasks@*/node_modules/@google-cloud/tasks/build/**/*.json",
      "../../node_modules/.pnpm/google-gax@*/node_modules/google-gax/build/protos/**",
    ],
  },
  poweredByHeader: false,
  // Lint runs from the repo root (`pnpm lint`); Next's own ESLint pass is skipped during build.
  eslint: { ignoreDuringBuilds: true },
  // The intake browser harness only (test/catalog-intake.server.ts, next dev with INTAKE_HARNESS=1):
  // the server bundle's `undici` becomes the harness's fake image host, so pasted links never reach
  // the network. Never applied to `next build`, and kept in its own webpack cache so a later plain
  // `next dev` does not reuse it.
  webpack(config, { dev, isServer }) {
    if (dev && isServer && process.env.INTAKE_HARNESS === "1") {
      config.resolve.alias = { ...config.resolve.alias, undici$: path.join(__dirname, "test/catalog-intake.undici.ts") };
      if (config.cache && typeof config.cache === "object") config.cache.name = `${config.cache.name ?? "cache"}-intake-harness`;
    }
    return config;
  },
};

export default nextConfig;
