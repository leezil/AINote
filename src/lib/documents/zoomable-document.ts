import { useCallback, useEffect, useRef, useState } from "react";

export const MIN_ZOOM_SCALE = 0.22;
export const MAX_ZOOM_SCALE = 10;
export const MAX_DOCUMENT_RENDER_PX = 12_000;
export const FIT_WIDTH_RESIZE_DEBOUNCE_MS = 72;

export function clampZoomScale(s: number): number {
  return Math.max(MIN_ZOOM_SCALE, Math.min(MAX_ZOOM_SCALE, s));
}

export function computeRenderWidth(fitWidth: number, committedScale: number): number {
  const safe = clampZoomScale(committedScale);
  return Math.min(
    MAX_DOCUMENT_RENDER_PX,
    Math.max(280, Math.round(Math.max(280, fitWidth) * safe)),
  );
}

export function isDocumentSharpening(
  viewportScale: number,
  committedScale: number,
): boolean {
  return Math.abs(clampZoomScale(viewportScale) - clampZoomScale(committedScale)) > 0.04;
}

type FitWidthOptions = {
  maxWidthPx?: number;
  wideMode?: boolean;
  /** 너비 재측정 트리거 (문서 id, 페이지 등) */
  remeasureKey?: string | number;
};

export function useFitDocumentWidth({
  maxWidthPx = 8192,
  wideMode = false,
  remeasureKey,
}: FitWidthOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cap = wideMode ? 8192 : maxWidthPx;

  const [containerWidth, setContainerWidth] = useState(() => {
    if (typeof window === "undefined") {
      return wideMode ? Math.min(cap, 1600) : Math.min(maxWidthPx, 1100);
    }
    return wideMode
      ? Math.min(cap, Math.floor(window.innerWidth * 0.92))
      : Math.min(maxWidthPx, Math.floor(Math.min(window.innerWidth - 48, maxWidthPx)));
  });

  const applyMeasuredWidth = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    let w = Math.floor(el.getBoundingClientRect().width);
    if (w < 64 && typeof window !== "undefined") {
      w = wideMode
        ? Math.floor(Math.min(cap, window.innerWidth * 0.9))
        : Math.min(maxWidthPx, Math.max(320, Math.floor(window.innerWidth - 48)));
    }
    setContainerWidth(Math.max(280, Math.min(cap, w)));
  }, [cap, maxWidthPx, wideMode]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleMeasure = () => {
      if (debounce != null) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        applyMeasuredWidth();
      }, FIT_WIDTH_RESIZE_DEBOUNCE_MS);
    };
    const ro = new ResizeObserver(scheduleMeasure);
    ro.observe(el);
    applyMeasuredWidth();
    return () => {
      ro.disconnect();
      if (debounce != null) clearTimeout(debounce);
    };
  }, [applyMeasuredWidth, cap, maxWidthPx, wideMode]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled) applyMeasuredWidth();
    };
    const id0 = requestAnimationFrame(() => {
      tick();
      requestAnimationFrame(tick);
    });
    const t = window.setTimeout(tick, 120);
    return () => {
      cancelled = true;
      cancelAnimationFrame(id0);
      window.clearTimeout(t);
    };
  }, [applyMeasuredWidth, remeasureKey, wideMode]);

  const fitWidth = Math.max(280, containerWidth);

  return { containerRef, fitWidth };
}
