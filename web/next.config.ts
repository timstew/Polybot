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
              destination: "http://localhost:8000/api/:path*",
            },
          ];
        },
      }
    : {}),
};

export default nextConfig;
