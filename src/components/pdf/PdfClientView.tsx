"use client";

import { useI18n } from "@/lib/i18n/LocaleProvider";
import { useEffect, useMemo, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
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
  const sharpening = isDocumentSharpening(viewportScale, committedScale);
  const atMaxRaster = renderWidth >= MAX_PDF_CANVAS_SIDE_PX - 8;

  const windowDpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const pdfDevicePixelRatio = computePdfDevicePixelRatio(
    committedScale,
    viewportScale,
    windowDpr,
    renderWidth,
  );
  const [renderFailed, setRenderFailed] = useState(false);

  useEffect(() => {
    setRenderFailed(false);
  }, [pageNumber, renderKey, fileUrl]);

  const file = useMemo(() => ({ url: fileUrl }), [fileUrl]);

  return (
    <div className="ainote-no-select flex w-full min-w-0 justify-center bg-zinc-100/80 dark:bg-zinc-900/60">
      <div
        className="relative mx-auto flex justify-center"
        style={{
          width: renderWidth,
          minHeight: wideMode ? 0 : 360,
        }}
      >
        <div className="ainote-no-select relative flex min-h-[200px] w-full justify-center bg-zinc-100/80 dark:bg-zinc-900/60">
          {sharpening ? (
            <span className="pointer-events-none absolute right-1 top-1 z-10 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
              {t("pdf.sharpening")}
            </span>
          ) : null}
          {atMaxRaster ? (
            <span className="pointer-events-none absolute left-1 top-1 z-10 max-w-[85%] rounded bg-amber-900/75 px-1.5 py-0.5 text-[10px] text-amber-50">
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
            onLoadSuccess={(pdf) => {
              onPdfLoaded?.(pdf.numPages);
            }}
            loading={
              <p className="min-h-[36vh] p-8 text-center text-sm text-zinc-500 md:min-h-[320px]">
                {t("pdf.loading")}
              </p>
            }
            error={<p className="p-4 text-sm text-red-600">{t("pdf.error")}</p>}
          >
            <Page
              key={`${pageNumber}-${renderKey}`}
              pageNumber={pageNumber}
              width={renderWidth}
              devicePixelRatio={pdfDevicePixelRatio}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              onRenderSuccess={() => setRenderFailed(false)}
              onRenderError={() => setRenderFailed(true)}
            />
          </Document>
        </div>
      </div>
    </div>
  );
}
