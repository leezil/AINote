import { useCallback, useEffect, useRef, useState } from "react";
import { clampZoomScale } from "@/lib/documents/zoomable-document";

/** 핀치·휠 중 CSS만 움직이고, 멈춘 뒤 PDF를 이 배율로 다시 그립니다. */
export const PDF_RASTER_COMMIT_MS = 220;
const COMMIT_EPSILON = 0.025;

/**
 * 제스처 배율(zoom)과 래스터에 굳힌 배율(committed)을 분리합니다.
 * - 제스처 중: CSS scale = zoom / committed (부드러운 확대)
 * - 제스처 종료·디바운스 후: committed = zoom, CSS scale = 1 (선명)
 */
export function useCommittedPdfScale(initial = 1) {
  const [zoomScale, setZoomScale] = useState(initial);
  const [committedScale, setCommittedScale] = useState(initial);
  const committedRef = useRef(initial);
  committedRef.current = committedScale;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyCommitted = useCallback((s: number) => {
    const next = clampZoomScale(s);
    if (Math.abs(next - committedRef.current) < COMMIT_EPSILON) return;
    committedRef.current = next;
    setCommittedScale(next);
  }, []);

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

  const onGestureScaleChange = useCallback(
    (s: number) => {
      setZoomScale(clampZoomScale(s));
      scheduleCommitted(s);
    },
    [scheduleCommitted],
  );

  const onGestureScaleSettled = useCallback(
    (s: number) => {
      const next = clampZoomScale(s);
      setZoomScale(next);
      flushCommitted(next);
    },
    [flushCommitted],
  );

  const resetScales = useCallback(
    (s = 1) => {
      const next = clampZoomScale(s);
      flushCommitted(next);
      setZoomScale(next);
    },
    [flushCommitted],
  );

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
