import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: process.env.SITE_BASE_PATH || "",
  assetPrefix: process.env.SITE_BASE_PATH || "",
  images: { unoptimized: true },
};

export default nextConfig;
