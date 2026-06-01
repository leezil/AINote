import { clampZoomScale } from "@/lib/documents/zoomable-document";

/** PDF 캔버스 DPR 상한 (iPad Retina 등) */
export const MAX_PDF_DEVICE_PIXEL_RATIO = 8;

/**
 * 화면 배율 1×일 때도 Retina에서 선명하도록 DPR을 올립니다.
 * `viewportScale`을 반영해 핀치 중에도 너무 깨지지 않게 합니다.
 */
export function computePdfDevicePixelRatio(
  committedScale: number,
  viewportScale: number,
  windowDevicePixelRatio: number,
): number {
  const base = Math.max(1, windowDevicePixelRatio);
  const visual = clampZoomScale(Math.max(committedScale, viewportScale * 0.92));
  const dpr = base * (1.85 + 0.65 * visual);
  return Math.min(MAX_PDF_DEVICE_PIXEL_RATIO, Math.max(2.5, dpr));
}
