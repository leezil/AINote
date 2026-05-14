"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

/**
 * 표시 너비(`displayW`)보다 큰 width로 PDF를 렌더한 뒤 `zoom`으로 맞춤.
 * (픽셀 밀도 + 축소 표시로 첫 화면부터 덜 깨짐)
 */
const WIDTH_OVERSAMPLE = 1.82;

type Props = {
  fileUrl: string;
  pageNumber: number;
  maxWidthPx?: number;
  wideMode?: boolean;
  viewportScale?: number;
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
    const t = window.setTimeout(tick, 120);
    return () => {
      cancelled = true;
      cancelAnimationFrame(id0);
      window.clearTimeout(t);
    };
  }, [applyMeasuredWidth, pageNumber, wideMode, fileUrl]);

  const displayW = Math.max(280, containerWidth);
  const renderWidth = Math.round(Math.min(cap, displayW * WIDTH_OVERSAMPLE));
  const fitZoom = renderWidth > 0 ? displayW / renderWidth : 1;

  const baseDpr =
    typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 3) : 1;
  const pdfDevicePixelRatio = Math.min(
    14,
    Math.max(1.45, baseDpr * Math.max(1, viewportScale) * 1.12),
  );

  const file = useMemo(() => ({ url: fileUrl }), [fileUrl]);

  return (
    <div ref={containerRef} className="flex w-full justify-center bg-zinc-100/80 dark:bg-zinc-900/60">
      <div
        className="mx-auto flex justify-center overflow-hidden"
        style={{
          width: displayW,
          maxWidth: "100%",
          minHeight: wideMode ? "42vh" : 360,
        }}
      >
        <div
          className="flex justify-center"
          style={
            {
              width: renderWidth,
              zoom: fitZoom,
            } as CSSProperties
          }
        >
          <Document
            key={fileUrl}
            file={file}
            onLoadSuccess={(pdf) => {
              onPdfLoaded?.(pdf.numPages);
            }}
            loading={
              <p className="min-h-[36vh] p-8 text-center text-sm text-zinc-500 md:min-h-[320px]">
                PDF 불러오는 중…
              </p>
            }
            error={<p className="p-4 text-sm text-red-600">PDF를 표시할 수 없습니다.</p>}
          >
            <Page
              key={pageNumber}
              pageNumber={pageNumber}
              width={renderWidth}
              devicePixelRatio={pdfDevicePixelRatio}
              renderTextLayer={false}
              renderAnnotationLayer={false}
            />
          </Document>
        </div>
      </div>
    </div>
  );
}
