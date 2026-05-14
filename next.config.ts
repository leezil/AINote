import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /** pdfjs is resolved via react-pdf; keep it external for server routes. */
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
  /**
   * Node 런타임에서 pdf.js fake worker가 `import(pdf.worker.mjs)`를 하는데,
   * 기본 트레이싱에 worker 파일이 빠져 Vercel에서 "Cannot find module ... pdf.worker.mjs"가 납니다.
   */
  outputFileTracingIncludes: {
    "/api/ai/ask": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/documents": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
};

export default nextConfig;
