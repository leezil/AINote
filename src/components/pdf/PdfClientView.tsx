"use client";

import { useI18n } from "@/lib/i18n/LocaleProvider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

/**
 * `Page width={displayW}` + `devicePixelRatio`로 선명도 보정(CSS `zoom` 미사용).
 * 확대는 ZoomPanSurface의 CSS `scale`로 먼저 적용되므로, 여기서는 디바운스된 스케일로만
 * DPR을 올려 핀치·휠 중 매 프레임 거대 캔버스를 다시 그리는 병목을 줄입니다.
 */
const SHARPNESS_BOOST = 1.32;
const MAX_PDF_DPR = 6.5;
const RASTER_SCALE_SETTLE_MS = 200;
const RESIZE_DEBOUNCE_MS = 72;

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
  const { t } = useI18n();
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
      }, RESIZE_DEBOUNCE_MS);
    };
    const ro = new ResizeObserver(() => {
      scheduleMeasure();
    });
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

  /** 핀치·휠이 멈춘 뒤에만 반영 — CSS scale로 즉시 확대, 선명도는 잠시 후 맞춤 */
  const latestScaleRef = useRef(viewportScale);
  latestScaleRef.current = viewportScale;
  const [rasterScale, setRasterScale] = useState(viewportScale);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setRasterScale(latestScaleRef.current);
    }, RASTER_SCALE_SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [viewportScale]);

  useEffect(() => {
    setRasterScale(latestScaleRef.current);
  }, [pageNumber, fileUrl, wideMode]);

  const baseDpr =
    typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 3) : 1;
  const pdfDevicePixelRatio = Math.min(
    MAX_PDF_DPR,
    Math.max(1.45, baseDpr * Math.max(1, rasterScale) * 1.1 * SHARPNESS_BOOST),
  );

  const file = useMemo(() => ({ url: fileUrl }), [fileUrl]);

  return (
    <div
      ref={containerRef}
      className="ainote-no-select flex w-full justify-center bg-zinc-100/80 dark:bg-zinc-900/60"
    >
      <div
        className="relative mx-auto flex justify-center overflow-hidden"
        style={{
          width: displayW,
          maxWidth: "100%",
          minHeight: wideMode ? 0 : 360,
        }}
      >
        <div className="ainote-no-select relative flex w-full justify-center">
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
              key={pageNumber}
              pageNumber={pageNumber}
              width={displayW}
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
