import { MAX_PDF_CANVAS_SIDE_PX } from "@/lib/documents/pdf-render-quality";

/** 문서 좌표(현재 배율 기준 CSS px) 타일 한 칸 크기 */
export const PDF_TILE_CSS_PX = 480;

export type TileCoord = { col: number; row: number };

export type TileSpec = TileCoord & {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export function pageDimensions(fitWidth: number, scale: number, aspect: number) {
  const w = Math.max(280, fitWidth) * Math.max(0.22, scale);
  const h = Math.max(200, w * aspect);
  return { pageWidth: w, pageHeight: h };
}

export function tileSpec(
  col: number,
  row: number,
  pageWidth: number,
  pageHeight: number,
  tileSize = PDF_TILE_CSS_PX,
): TileSpec {
  const x = col * tileSize;
  const y = row * tileSize;
  const w = Math.min(tileSize, pageWidth - x);
  const h = Math.min(tileSize, pageHeight - y);
  return { col, row, key: `${col},${row}`, x, y, w, h };
}

/** 화면에서 겹치는 영역 → 타일 목록 (페이지 박스 좌표 = 문서 좌표) */
export function visibleTilesForView(params: {
  viewportLeft: number;
  viewportTop: number;
  viewportWidth: number;
  viewportHeight: number;
  pageLeft: number;
  pageTop: number;
  pageWidth: number;
  pageHeight: number;
  tileSize?: number;
  marginTiles?: number;
}): TileSpec[] {
  const {
    viewportLeft,
    viewportTop,
    viewportWidth,
    viewportHeight,
    pageLeft,
    pageTop,
    pageWidth,
    pageHeight,
    tileSize = PDF_TILE_CSS_PX,
    marginTiles = 1,
  } = params;

  const vRight = viewportLeft + viewportWidth;
  const vBottom = viewportTop + viewportHeight;
  const pRight = pageLeft + pageWidth;
  const pBottom = pageTop + pageHeight;

  const overlapLeft = Math.max(viewportLeft, pageLeft);
  const overlapTop = Math.max(viewportTop, pageTop);
  const overlapRight = Math.min(vRight, pRight);
  const overlapBottom = Math.min(vBottom, pBottom);

  if (overlapRight <= overlapLeft || overlapBottom <= overlapTop) {
    return [];
  }

  const docLeft = overlapLeft - pageLeft;
  const docTop = overlapTop - pageTop;
  const docRight = overlapRight - pageLeft;
  const docBottom = overlapBottom - pageTop;

  const col0 = Math.max(0, Math.floor(docLeft / tileSize) - marginTiles);
  const row0 = Math.max(0, Math.floor(docTop / tileSize) - marginTiles);
  const col1 = Math.min(
    Math.ceil(pageWidth / tileSize) - 1,
    Math.floor(docRight / tileSize) + marginTiles,
  );
  const row1 = Math.min(
    Math.ceil(pageHeight / tileSize) - 1,
    Math.floor(docBottom / tileSize) + marginTiles,
  );

  const out: TileSpec[] = [];
  for (let row = row0; row <= row1; row++) {
    for (let col = col0; col <= col1; col++) {
      out.push(tileSpec(col, row, pageWidth, pageHeight, tileSize));
    }
  }
  return out;
}

/** 타일 캔버스 픽셀 상한 내 DPR */
export function tileDevicePixelRatio(
  tileCssW: number,
  tileCssH: number,
  pdfRenderScale: number,
  windowDpr: number,
): number {
  const base = Math.max(1, windowDpr);
  let dpr = Math.min(3, base * 1.25);
  const wPx = tileCssW * pdfRenderScale * dpr;
  const hPx = tileCssH * pdfRenderScale * dpr;
  const capW = MAX_PDF_CANVAS_SIDE_PX / Math.max(64, wPx);
  const capH = MAX_PDF_CANVAS_SIDE_PX / Math.max(64, hPx);
  dpr = Math.min(dpr, capW, capH);
  return Math.max(1, dpr);
}
