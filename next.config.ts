import type { NextConfig } from "next";
import pkg from "./package.json";

// The chandler edition: a fully static site (out/) that nginx serves under
// /bookplate, next to the EPUB library and a WebDAV data folder. There is no
// Node.js server, so security headers are set by nginx, not here.
const basePath = "/bookplate";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  // Every page is a folder with index.html, which nginx serves as-is.
  trailingSlash: true,
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  // Hide the dev-mode Next.js indicator ("N" bubble in the corner).
  devIndicators: false,
};

export default nextConfig;
