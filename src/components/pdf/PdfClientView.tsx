"use client";

import { useI18n } from "@/lib/i18n/LocaleProvider";
import { useEffect, useMemo, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import type { PDFPageProxy } from "pdfjs-dist";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import {
  computeRenderWidth,
  isDocumentSharpening,
  quantizeRenderWidthPx,
  useFitDocumentWidth,
} from "@/lib/documents/zoomable-document";
import {
  computePdfDevicePixelRatio,
  MAX_PDF_CANVAS_SIDE_PX,
  PDF_PAGE_ASPECT_HEIGHT,
} from "@/lib/documents/pdf-render-quality";

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

type Props = {
  fileUrl: string;
  pageNumber: number;
  maxWidthPx?: number;
  wideMode?: boolean;
  viewportScale?: number;
  committedScale?: number;
  onPdfLoaded?: (numPages: number) => void;
};

export function PdfClientView({
  fileUrl,
  pageNumber,
  maxWidthPx = 1200,
  wideMode = false,
  viewportScale = 1,
  committedScale = 1,
  onPdfLoaded,
}: Props) {
  const { t } = useI18n();
  const { fitWidth } = useFitDocumentWidth({ maxWidthPx, wideMode });
  const renderWidth = computeRenderWidth(fitWidth, committedScale);
  const renderKey = quantizeRenderWidthPx(renderWidth);
  const sharpening = isDocumentSharpening(viewportScale, committedScale, fitWidth);
  const atMaxRaster = renderWidth >= MAX_PDF_CANVAS_SIDE_PX - 8;

  const [pageAspect, setPageAspect] = useState(PDF_PAGE_ASPECT_HEIGHT);
  const renderHeight = Math.max(200, Math.round(renderWidth * pageAspect));

  const windowDpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const baseDpr = computePdfDevicePixelRatio(
    committedScale,
    viewportScale,
    windowDpr,
    renderWidth,
  );
  const [dprFloor, setDprFloor] = useState(baseDpr);
  const pdfDevicePixelRatio = Math.min(baseDpr, dprFloor);
  const [renderFailed, setRenderFailed] = useState(false);
  const [renderReady, setRenderReady] = useState(false);

  useEffect(() => {
    setPageAspect(PDF_PAGE_ASPECT_HEIGHT);
  }, [pageNumber, fileUrl]);

  useEffect(() => {
    setDprFloor(baseDpr);
    setRenderFailed(false);
    setRenderReady(false);
  }, [pageNumber, renderKey, fileUrl, baseDpr]);

  const file = useMemo(() => ({ url: fileUrl }), [fileUrl]);

  const onPageLoad = (page: PDFPageProxy) => {
    const vp = page.getViewport({ scale: 1 });
    if (vp.width > 0) {
      setPageAspect(vp.height / vp.width);
    }
  };

  return (
    <div
      className="ainote-no-select relative inline-block align-top bg-zinc-100/80 dark:bg-zinc-900/60"
      style={{ width: renderWidth, height: renderHeight }}
      data-pdf-page-box
    >
      {sharpening ? (
        <span className="pointer-events-none absolute right-1 top-1 z-10 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
          {t("pdf.sharpening")}
        </span>
      ) : null}
      {atMaxRaster ? (
        <span className="pointer-events-none absolute left-1 top-1 z-10 max-w-[90%] rounded bg-amber-900/75 px-1.5 py-0.5 text-[10px] text-amber-50">
          {t("pdf.maxZoomRaster")}
        </span>
      ) : null}
      {renderFailed ? (
        <p className="absolute inset-0 z-20 flex items-center justify-center p-4 text-center text-sm text-red-600 dark:text-red-400">
          {t("pdf.renderFailed")}
        </p>
      ) : null}
      <Document
        key={fileUrl}
        file={file}
        className="block"
        onLoadSuccess={(pdf) => {
          onPdfLoaded?.(pdf.numPages);
        }}
        loading={
          renderReady ? null : (
            <div
              className="flex items-center justify-center bg-zinc-100/90 text-sm text-zinc-500 dark:bg-zinc-900/90"
              style={{ width: renderWidth, height: renderHeight }}
            >
              {t("pdf.loading")}
            </div>
          )
        }
        error={
          <p className="p-4 text-sm text-red-600" style={{ width: renderWidth }}>
            {t("pdf.error")}
          </p>
        }
      >
        <Page
          key={`${pageNumber}-${renderKey}`}
          pageNumber={pageNumber}
          width={renderWidth}
          devicePixelRatio={pdfDevicePixelRatio}
          renderMode="canvas"
          renderTextLayer={false}
          renderAnnotationLayer={false}
          onLoadSuccess={onPageLoad}
          onRenderSuccess={() => {
            setRenderFailed(false);
            setRenderReady(true);
          }}
          onRenderError={() => {
            if (pdfDevicePixelRatio > 1) {
              setDprFloor((d) => Math.max(1, d * 0.5));
              return;
            }
            setRenderFailed(true);
          }}
          className="block max-w-none"
          canvasBackground="rgb(244, 244, 245)"
        />
      </Document>
    </div>
  );
}
