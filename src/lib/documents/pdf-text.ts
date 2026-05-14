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

/**
 * 모든 페이지 텍스트를 이어 붙입니다. AI "전체 문서" 질문용.
 * `maxTotalChars`를 넘기면 잘라 `truncated`를 true로 둡니다.
 */
export async function extractPdfAllPagesText(
  buffer: Buffer,
  options: { maxTotalChars: number; pageCountHint?: number },
): Promise<{ text: string; pageCount: number; truncated: boolean }> {
  let pageCount = 0;
  let firstText = "";
  try {
    const first = await extractPdfPageText(buffer, 1);
    pageCount = first.pageCount;
    firstText = first.text;
  } catch {
    pageCount = options.pageCountHint ?? 0;
  }
  if (pageCount < 1) {
    pageCount = options.pageCountHint ?? 1;
  }

  const max = options.maxTotalChars;
  let acc = `\n\n--- 페이지 1/${pageCount} ---\n${firstText || "(텍스트 없음)"}`;
  if (acc.length >= max) {
    return { text: acc.slice(0, max).trim(), pageCount, truncated: true };
  }

  let truncated = false;
  for (let p = 2; p <= pageCount; p++) {
    let text = "";
    try {
      const r = await extractPdfPageText(buffer, p);
      text = r.text;
    } catch {
      text = "";
    }
    const block = `\n\n--- 페이지 ${p}/${pageCount} ---\n${text || "(텍스트 없음)"}`;
    if (acc.length + block.length > max) {
      acc += block.slice(0, max - acc.length);
      truncated = true;
      break;
    }
    acc += block;
  }

  return { text: acc.trim(), pageCount, truncated };
}
