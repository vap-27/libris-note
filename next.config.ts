import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.STANDALONE ? { output: "standalone" } : {}),
  serverExternalPackages: ["@prisma/client"],
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
