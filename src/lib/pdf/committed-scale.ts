import { useCallback, useEffect, useRef, useState } from "react";
import { clampZoomScale } from "@/lib/documents/zoomable-document";

/** 핀치·휠 중 CSS만 움직이고, 멈춘 뒤 PDF를 이 배율로 다시 그립니다. */
export const PDF_RASTER_COMMIT_MS =
  typeof window !== "undefined" && "ontouchstart" in window ? 150 : 220;
const COMMIT_EPSILON =
  typeof window !== "undefined" && "ontouchstart" in window ? 0.02 : 0.025;

/**
 * 제스처 배율(zoom)과 래스터에 굳힌 배율(committed)을 분리합니다.
 * - 제스처 중: CSS scale = zoom / committed (부드러운 확대)
 * - 제스처 종료·디바운스 후: committed = zoom, CSS scale = 1 (선명)
 */
export function useCommittedPdfScale(initial = 1, maxRasterScale = 10) {
  const [zoomScale, setZoomScale] = useState(initial);
  const [committedScale, setCommittedScale] = useState(() =>
    Math.min(clampZoomScale(initial), maxRasterScale),
  );
  const committedRef = useRef(committedScale);
  committedRef.current = committedScale;
  const maxRasterRef = useRef(maxRasterScale);
  maxRasterRef.current = maxRasterScale;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyCommitted = useCallback((s: number) => {
    const next = clampZoomScale(Math.min(s, maxRasterRef.current));
    if (Math.abs(next - committedRef.current) < COMMIT_EPSILON) return;
    committedRef.current = next;
    setCommittedScale(next);
  }, []);

  useEffect(() => {
    const cap = maxRasterScale;
    if (committedRef.current <= cap) return;
    committedRef.current = cap;
    setCommittedScale(cap);
  }, [maxRasterScale]);

  const flushCommitted = useCallback(
    (s: number) => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      applyCommitted(s);
    },
    [applyCommitted],
  );

  const scheduleCommitted = useCallback(
    (s: number) => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        applyCommitted(s);
      }, PDF_RASTER_COMMIT_MS);
    },
    [applyCommitted],
  );

  const capGestureScale = useCallback((s: number) => {
    return clampZoomScale(Math.min(s, maxRasterRef.current));
  }, []);

  const onGestureScaleChange = useCallback(
    (s: number) => {
      const next = capGestureScale(s);
      setZoomScale(next);
      scheduleCommitted(next);
    },
    [capGestureScale, scheduleCommitted],
  );

  const onGestureScaleSettled = useCallback(
    (s: number) => {
      const next = capGestureScale(s);
      setZoomScale(next);
      flushCommitted(next);
    },
    [capGestureScale, flushCommitted],
  );

  const resetScales = useCallback(
    (s = 1) => {
      const next = capGestureScale(s);
      flushCommitted(next);
      setZoomScale(next);
    },
    [capGestureScale, flushCommitted],
  );

  useEffect(() => {
    const cap = maxRasterScale;
    setZoomScale((z) => {
      const next = clampZoomScale(Math.min(z, cap));
      return next;
    });
    if (committedRef.current > cap) {
      committedRef.current = cap;
      setCommittedScale(cap);
    }
  }, [maxRasterScale]);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    };
  }, []);

  return {
    zoomScale,
    committedScale,
    onGestureScaleChange,
    onGestureScaleSettled,
    resetScales,
  };
}
