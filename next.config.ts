import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.STANDALONE ? { output: "standalone" } : {}),
  // Prisma + sharp must stay external (native bindings / engine binaries).
  // NOTE: our Prisma clients use custom outputs in src/generated/*, which
  // serverExternalPackages cannot match (it only covers node_modules/<pkg>/ —
  // see webpack-config optOutBundlingPackageRegex). Their two dynamic
  // process.cwd() probes are instead silenced with /*turbopackIgnore: true*/
  // markers re-applied by scripts/patch-prisma-turbopack-ignore.mjs after
  // every `prisma generate`. Deliberately NO outputFileTracingExcludes here:
  // it only post-filters .nft.json files (does not silence these warnings)
  // and excluding the clients would drop the query-engine binaries from
  // standalone traces and break production.
  serverExternalPackages: ["@prisma/client", "sharp"],
  /* Security hardening (I-1): fail builds on type errors, catch effect bugs. */
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  async headers() {
    // Enforced CSP (production only — dev HMR/Turbopack needs eval/inline).
    // NOTE: script-src keeps 'unsafe-inline' because Next.js ships inline
    // bootstrap scripts; stored-XSS defense is the server+client sanitizer
    // (src/lib/sanitize.ts), not this header. This policy still blocks
    // framing, plugins, and cross-origin exfiltration (connect-src 'self').
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      'upgrade-insecure-requests',
    ].join('; ')
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ...(process.env.NODE_ENV === 'production'
            ? [{ key: 'Content-Security-Policy', value: csp }]
            : []),
        ],
      },
    ]
  },
};

export default nextConfig;
