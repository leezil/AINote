"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  /** Called when PDF loads in the browser (authoritative page count on server parse failure). */
  onPdfLoaded?: (numPages: number) => void;
};

export function PdfClientView({
  fileUrl,
  pageNumber,
  maxWidthPx = 920,
  wideMode = false,
  onPdfLoaded,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cap = wideMode ? 8192 : maxWidthPx;
  const [containerWidth, setContainerWidth] = useState(() =>
    wideMode ? Math.min(cap, 1400) : Math.min(maxWidthPx, 920),
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.getBoundingClientRect().width;
      setContainerWidth(Math.max(240, Math.min(cap, Math.floor(w))));
    });
    ro.observe(el);
    setContainerWidth(Math.max(240, Math.min(cap, Math.floor(el.getBoundingClientRect().width))));
    return () => ro.disconnect();
  }, [cap, maxWidthPx, wideMode]);

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
          pageNumber={pageNumber}
          width={containerWidth}
          renderTextLayer={false}
          renderAnnotationLayer={false}
        />
      </Document>
    </div>
  );
}
