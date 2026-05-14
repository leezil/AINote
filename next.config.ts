import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /** pdfjs is resolved via react-pdf; keep it external for server routes. */
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
