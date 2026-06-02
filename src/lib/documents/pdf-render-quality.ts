import { clampZoomScale } from "@/lib/documents/zoomable-document";

/** PDF 캔버스 DPR 상한 (iPad Retina 등) */
export const MAX_PDF_DEVICE_PIXEL_RATIO = 8;

/** 브라우저·iPad에서 캔버스 한 변 최대 px (초과 시 흰 화면·렌더 실패) */
export const MAX_PDF_CANVAS_SIDE_PX = 8192;

/** A4 세로 등 — 높이 한도용 보수적 종횡비 */
export const PDF_PAGE_ASPECT_HEIGHT = 1.414;

/**
 * 화면 배율 1×일 때도 Retina에서 선명하도록 DPR을 올립니다.
 * `renderWidthPx`에 맞춰 DPR을 줄여 캔버스가 한도를 넘지 않게 합니다.
 */
export function computePdfDevicePixelRatio(
  committedScale: number,
  viewportScale: number,
  windowDevicePixelRatio: number,
  renderWidthPx: number,
): number {
  const base = Math.max(1, windowDevicePixelRatio);
  const visual = clampZoomScale(Math.max(committedScale, viewportScale * 0.92));
  let dpr = base * (1.85 + 0.65 * visual);
  dpr = Math.min(MAX_PDF_DEVICE_PIXEL_RATIO, Math.max(2.5, dpr));

  const w = Math.max(280, renderWidthPx);
  const capByWidth = MAX_PDF_CANVAS_SIDE_PX / w;
  const capByHeight = MAX_PDF_CANVAS_SIDE_PX / (w * PDF_PAGE_ASPECT_HEIGHT);
  dpr = Math.min(dpr, capByWidth, capByHeight);

  return Math.max(1, dpr);
}
