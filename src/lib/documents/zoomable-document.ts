import { useMemo } from "react";
import { useZoomPanViewportWidth } from "@/components/workspace/ZoomPanViewportWidthContext";

export const MIN_ZOOM_SCALE = 0.22;
export const MAX_ZOOM_SCALE = 10;
export const MAX_DOCUMENT_RENDER_PX = 12_000;
/** Page/이미지 재렌더 키 안정화 (px 단위 양자화, 작을수록 단계가 촘촘) */
export const RENDER_WIDTH_QUANTUM = 8;

export function clampZoomScale(s: number): number {
  return Math.max(MIN_ZOOM_SCALE, Math.min(MAX_ZOOM_SCALE, s));
}

export function quantizeRenderWidthPx(width: number): number {
  const q = RENDER_WIDTH_QUANTUM;
  return Math.max(280, Math.round(width / q) * q);
}

export function computeRenderWidth(fitWidth: number, committedScale: number): number {
  const safe = clampZoomScale(committedScale);
  const raw = Math.max(280, fitWidth) * safe;
  return Math.min(MAX_DOCUMENT_RENDER_PX, quantizeRenderWidthPx(raw));
}

export function isDocumentSharpening(
  viewportScale: number,
  committedScale: number,
): boolean {
  return Math.abs(clampZoomScale(viewportScale) - clampZoomScale(committedScale)) > 0.05;
}

type FitWidthOptions = {
  maxWidthPx?: number;
  wideMode?: boolean;
  /** @deprecated 뷰포트 컨텍스트 사용. API 호환용 */
  remeasureKey?: string | number;
};

/**
 * 문서 fit 너비 = ZoomPan 뷰포트 너비(확대된 콘텐츠 크기와 무관).
 * renderWidth = fitWidth × committedScale 로 선명도를 맞춥니다.
 */
export function useFitDocumentWidth({
  maxWidthPx = 8192,
  wideMode = false,
}: FitWidthOptions = {}) {
  const viewportW = useZoomPanViewportWidth();
  const cap = wideMode ? 8192 : maxWidthPx;

  const fitWidth = useMemo(
    () => Math.max(280, Math.min(cap, Math.floor(viewportW))),
    [cap, viewportW],
  );

  return { fitWidth };
}
