"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

type Props = {
  fileUrl: string;
  pageNumber: number;
  /** Wider PDFs scale down to this width (px) to reduce client paint cost. */
  maxWidthPx?: number;
  /** 전체화면 등: 부모 너비에 맞추되 상한을 크게(최대 8192px). */
  wideMode?: boolean;
  /**
   * ZoomPanSurface CSS scale과 동기화. 1보다 크면 같은 CSS 너비 안에 더 촘촘한 캔버스를 그려
   * 확대 시 글자가 덜 깨지게 함(react-pdf `devicePixelRatio` 보정).
   */
  viewportScale?: number;
  /** Called when PDF loads in the browser (authoritative page count on server parse failure). */
  onPdfLoaded?: (numPages: number) => void;
};

export function PdfClientView({
  fileUrl,
  pageNumber,
  maxWidthPx = 1200,
  wideMode = false,
  viewportScale = 1,
  onPdfLoaded,
}: Props) {
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
    const ro = new ResizeObserver(() => {
      applyMeasuredWidth();
    });
    ro.observe(el);
    applyMeasuredWidth();
    return () => ro.disconnect();
  }, [applyMeasuredWidth, cap, maxWidthPx, wideMode]);

  /** 전체화면·페이지 전환 직후 레이아웃이 0폭이었다가 잡히는 경우 재측정 */
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      applyMeasuredWidth();
    };
    const id0 = requestAnimationFrame(() => {
      tick();
      requestAnimationFrame(tick);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id0);
    };
  }, [applyMeasuredWidth, pageNumber, wideMode, fileUrl]);

  const baseDpr =
    typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 3) : 1;
  /** CSS 확대 배율만큼 내부 렌더 해상도를 올려 transform scale 후에도 덜 깨지게 함 */
  const pdfDevicePixelRatio = Math.min(
    14,
    Math.max(1.25, baseDpr * Math.max(1, viewportScale) * 1.08),
  );

  const file = useMemo(() => ({ url: fileUrl }), [fileUrl]);

  return (
    <div ref={containerRef} className="flex justify-center bg-zinc-100/80 dark:bg-zinc-900/60">
      <Document
        file={file}
        onLoadSuccess={(pdf) => {
          onPdfLoaded?.(pdf.numPages);
        }}
        loading={<p className="p-4 text-sm text-zinc-500">PDF 불러오는 중…</p>}
        error={<p className="p-4 text-sm text-red-600">PDF를 표시할 수 없습니다.</p>}
      >
        <Page
          key={pageNumber}
          pageNumber={pageNumber}
          width={containerWidth}
          devicePixelRatio={pdfDevicePixelRatio}
          renderTextLayer={false}
          renderAnnotationLayer={false}
        />
      </Document>
    </div>
  );
}
