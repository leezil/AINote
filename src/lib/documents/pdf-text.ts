/**
 * Server-side PDF helpers (text only — avoids native render deps on Windows).
 * Scoped extraction: one page per AI request to keep tokens predictable.
 *
 * On Vercel / strict Node, pdf.js needs standard fonts + CMaps loaded over HTTPS
 * (bundled paths are not available the same way as in the browser worker).
 */

const PDFJS_DIST_VERSION = "5.4.296";
const PDFJS_ASSETS_BASE = `https://unpkg.com/pdfjs-dist@${PDFJS_DIST_VERSION}/`;

function getDocumentParams(buffer: Buffer) {
  return {
    data: new Uint8Array(buffer),
    disableWorker: true,
    isEvalSupported: false,
    standardFontDataUrl: `${PDFJS_ASSETS_BASE}standard_fonts/`,
    cMapUrl: `${PDFJS_ASSETS_BASE}cmaps/`,
    cMapPacked: true,
  };
}

export async function getPdfPageCount(buffer: Buffer): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument(getDocumentParams(buffer));
  const pdf = await loadingTask.promise;
  try {
    return pdf.numPages;
  } finally {
    await pdf.destroy();
  }
}

export async function extractPdfPageText(
  buffer: Buffer,
  pageNumber1Based: number,
): Promise<{ text: string; pageCount: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument(getDocumentParams(buffer));
  const pdf = await loadingTask.promise;
  try {
    const pageCount = pdf.numPages;
    if (pageNumber1Based < 1 || pageNumber1Based > pageCount) {
      return { text: "", pageCount };
    }
    const page = await pdf.getPage(pageNumber1Based);
    const textContent = await page.getTextContent();
    const strings = textContent.items
      .map((item: unknown) => {
        if (typeof item === "object" && item !== null && "str" in item) {
          return String((item as { str?: unknown }).str ?? "");
        }
        return "";
      })
      .filter(Boolean);
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    return { text, pageCount };
  } finally {
    await pdf.destroy();
  }
}
