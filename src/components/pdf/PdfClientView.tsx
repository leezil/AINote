"use client";

import { useI18n } from "@/lib/i18n/LocaleProvider";
import { useMemo } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import {
  computeRenderWidth,
  isDocumentSharpening,
  quantizeRenderWidthPx,
  useFitDocumentWidth,
} from "@/lib/documents/zoomable-document";

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const SHARPNESS_BOOST = 1.28;
const MAX_PDF_DPR = 4;

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

  const baseDpr =
    typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 3) : 1;
  const pdfDevicePixelRatio = Math.min(MAX_PDF_DPR, Math.max(1.35, baseDpr * SHARPNESS_BOOST));

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
        <div className="ainote-no-select relative flex w-full justify-center">
          {sharpening ? (
            <span className="pointer-events-none absolute right-1 top-1 z-10 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
              {t("pdf.sharpening")}
            </span>
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
            />
          </Document>
        </div>
      </div>
    </div>
  );
}
