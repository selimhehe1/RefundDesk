import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: [
    "@refunddesk/config",
    "@refunddesk/contracts",
    "@refunddesk/db",
    "@refunddesk/domain",
    "@refunddesk/notifications",
    "@refunddesk/observability",
    "@refunddesk/stripe-adapter",
  ],
  headers() {
    return Promise.resolve([{ source: "/(.*)", headers: securityHeaders }]);
  },
};

export default nextConfig;
