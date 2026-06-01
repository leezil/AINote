import { useCallback, useEffect, useRef, useState } from "react";

/** 핀치·휠 중 CSS만 움직이고, 멈춘 뒤 PDF를 이 배율로 다시 그립니다. */
export const PDF_RASTER_COMMIT_MS = 180;

/**
 * 제스처 배율(zoom)과 래스터에 굳힌 배율(committed)을 분리합니다.
 * - 제스처 중: CSS scale = zoom / committed (부드러운 확대)
 * - 제스처 종료·디바운스 후: committed = zoom, CSS scale = 1 (선명)
 */
export function useCommittedPdfScale(initial = 1) {
  const [zoomScale, setZoomScale] = useState(initial);
  const [committedScale, setCommittedScale] = useState(initial);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushCommitted = useCallback((s: number) => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setCommittedScale(s);
  }, []);

  const scheduleCommitted = useCallback(
    (s: number) => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCommittedScale(s);
      }, PDF_RASTER_COMMIT_MS);
    },
    [],
  );

  const onGestureScaleChange = useCallback(
    (s: number) => {
      setZoomScale(s);
      scheduleCommitted(s);
    },
    [scheduleCommitted],
  );

  const onGestureScaleSettled = useCallback(
    (s: number) => {
      setZoomScale(s);
      flushCommitted(s);
    },
    [flushCommitted],
  );

  const resetScales = useCallback((s = 1) => {
    flushCommitted(s);
    setZoomScale(s);
  }, [flushCommitted]);

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
