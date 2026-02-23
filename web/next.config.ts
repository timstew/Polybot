import type { NextConfig } from "next";

const isExport = process.env.NEXT_BUILD_EXPORT === "1";

const nextConfig: NextConfig = {
  ...(isExport ? { output: "export" } : {}),
  images: { unoptimized: true },
  // Rewrites only work in next dev / non-export builds
  ...(!isExport
    ? {
        async rewrites() {
          return [
            {
              source: "/api/:path*",
              destination: process.env.NEXT_PUBLIC_API_URL
                ? `${process.env.NEXT_PUBLIC_API_URL}/api/:path*`
                : "http://localhost:8787/api/:path*",
            },
          ];
        },
      }
    : {}),
};

export default nextConfig;
