"use client";

import { useI18n } from "@/lib/i18n/LocaleProvider";
import { useZoomPanTransform } from "@/components/workspace/ZoomPanTransformContext";
import { useFitDocumentWidth } from "@/lib/documents/zoomable-document";
import { PDF_PAGE_ASPECT_HEIGHT } from "@/lib/documents/pdf-render-quality";
import {
  pageDimensions,
  tileDevicePixelRatio,
  visibleTilesForView,
  type TileSpec,
} from "@/lib/pdf/tile-render";
import { pdfjs } from "react-pdf";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

type Props = {
  fileUrl: string;
  pageNumber: number;
  maxWidthPx?: number;
  wideMode?: boolean;
  onPdfLoaded?: (numPages: number) => void;
};

type TileEntry = {
  spec: TileSpec;
  canvas: HTMLCanvasElement;
};

export function TiledPdfClientView({
  fileUrl,
  pageNumber,
  maxWidthPx = 8192,
  wideMode = false,
  onPdfLoaded,
}: Props) {
  const { t } = useI18n();
  const { fitWidth } = useFitDocumentWidth({ maxWidthPx, wideMode });
  const transform = useZoomPanTransform();
  const pageRef = useRef<HTMLDivElement | null>(null);
  const tilesHostRef = useRef<HTMLDivElement | null>(null);

  const [aspect, setAspect] = useState(PDF_PAGE_ASPECT_HEIGHT);
  const [numPages, setNumPages] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageReady, setPageReady] = useState(false);

  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const pdfPageRef = useRef<PDFPageProxy | null>(null);
  const tileCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const renderGenRef = useRef(0);
  const renderingRef = useRef(false);
  const pendingTilesRef = useRef<TileSpec[]>([]);

  const { pageWidth, pageHeight } = useMemo(
    () => pageDimensions(fitWidth, transform.scale, aspect),
    [fitWidth, transform.scale, aspect],
  );

  const pdfRenderScale = useMemo(() => {
    const vp1 = pdfPageRef.current?.getViewport({ scale: 1 });
    if (!vp1 || vp1.width <= 0) return transform.scale;
    return (pageWidth / vp1.width);
  }, [pageWidth, transform.scale, pageReady]);

  const loadPdf = useCallback(async () => {
    setLoadError(null);
    setPageReady(false);
    tileCacheRef.current.clear();
    if (tilesHostRef.current) tilesHostRef.current.replaceChildren();

    if (pdfDocRef.current) {
      void pdfDocRef.current.destroy();
      pdfDocRef.current = null;
    }
    pdfPageRef.current = null;

    try {
      const task = pdfjs.getDocument({ url: fileUrl });
      const doc = await task.promise;
      pdfDocRef.current = doc;
      setNumPages(doc.numPages);
      onPdfLoaded?.(doc.numPages);

      const page = await doc.getPage(pageNumber);
      pdfPageRef.current = page;
      const vp = page.getViewport({ scale: 1 });
      if (vp.width > 0) setAspect(vp.height / vp.width);
      setPageReady(true);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "load failed");
    }
  }, [fileUrl, pageNumber, fitWidth, onPdfLoaded]);

  useEffect(() => {
    void loadPdf();
    return () => {
      renderGenRef.current += 1;
      if (pdfDocRef.current) {
        void pdfDocRef.current.destroy();
        pdfDocRef.current = null;
      }
    };
  }, [loadPdf]);

  const renderTile = useCallback(
    async (spec: TileSpec, gen: number) => {
      const page = pdfPageRef.current;
      if (!page || gen !== renderGenRef.current) return;

      const cached = tileCacheRef.current.get(spec.key);
      if (cached) return;

      const pdfScale = pdfRenderScale;
      const viewport = page.getViewport({ scale: pdfScale });
      const windowDpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const dpr = tileDevicePixelRatio(spec.w, spec.h, 1, windowDpr);

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(spec.w * dpr));
      canvas.height = Math.max(1, Math.floor(spec.h * dpr));
      canvas.className = "block max-w-none";
      canvas.style.width = `${spec.w}px`;
      canvas.style.height = `${spec.h}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      try {
        await page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: [1, 0, 0, 1, -spec.x, -spec.y],
        }).promise;
      } catch {
        return;
      }

      if (gen !== renderGenRef.current) return;

      tileCacheRef.current.set(spec.key, canvas);
      const host = tilesHostRef.current;
      if (!host) return;

      const wrap = document.createElement("div");
      wrap.dataset.tileKey = spec.key;
      wrap.style.position = "absolute";
      wrap.style.left = `${spec.x}px`;
      wrap.style.top = `${spec.y}px`;
      wrap.style.width = `${spec.w}px`;
      wrap.style.height = `${spec.h}px`;
      wrap.style.overflow = "hidden";
      wrap.appendChild(canvas);
      host.appendChild(wrap);
    },
    [pdfRenderScale],
  );

  const scheduleTilePass = useCallback(() => {
    const vpEl = document.querySelector("[data-ainote-zoom-viewport]");
    const pageEl = pageRef.current;
    if (!(vpEl instanceof HTMLElement) || !pageEl || !pageReady) return;

    const vpRect = vpEl.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();

    const tiles = visibleTilesForView({
      viewportLeft: vpRect.left,
      viewportTop: vpRect.top,
      viewportWidth: vpRect.width,
      viewportHeight: vpRect.height,
      pageLeft: pageRect.left,
      pageTop: pageRect.top,
      pageWidth,
      pageHeight,
    });

    const needed = new Set(tiles.map((t) => t.key));
    const host = tilesHostRef.current;
    if (host) {
      for (const child of [...host.children]) {
        if (child instanceof HTMLElement) {
          const k = child.dataset.tileKey;
          if (k && !needed.has(k)) {
            child.remove();
          }
        }
      }
    }

    for (const k of [...tileCacheRef.current.keys()]) {
      if (!needed.has(k)) tileCacheRef.current.delete(k);
    }

    pendingTilesRef.current = tiles.filter((t) => !tileCacheRef.current.has(t.key));
    if (renderingRef.current) return;
    renderingRef.current = true;
    const gen = renderGenRef.current;

    void (async () => {
      for (const spec of pendingTilesRef.current) {
        if (gen !== renderGenRef.current) break;
        await renderTile(spec, gen);
      }
      renderingRef.current = false;
      if (
        pendingTilesRef.current.length > 0 &&
        gen === renderGenRef.current
      ) {
        scheduleTilePass();
      }
    })();
  }, [pageReady, pageWidth, pageHeight, renderTile]);

  useEffect(() => {
    if (!pageReady) return;
    renderGenRef.current += 1;
    tileCacheRef.current.clear();
    if (tilesHostRef.current) tilesHostRef.current.replaceChildren();

    const id = requestAnimationFrame(() => scheduleTilePass());
    return () => cancelAnimationFrame(id);
  }, [
    pageReady,
    pageNumber,
    fileUrl,
    pageWidth,
    pageHeight,
    pdfRenderScale,
    transform.scale,
    transform.panX,
    transform.panY,
    transform.viewportWidth,
    transform.viewportHeight,
    scheduleTilePass,
  ]);

  useEffect(() => {
    if (!pageReady) return;
    let raf = 0;
    const onMove = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => scheduleTilePass());
    };
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [pageReady, scheduleTilePass]);

  if (loadError) {
    return <p className="p-4 text-sm text-red-600">{t("pdf.error")}</p>;
  }

  return (
    <div
      ref={pageRef}
      data-pdf-page-box
      className="ainote-no-select relative inline-block shrink-0 overflow-hidden bg-zinc-100/80 dark:bg-zinc-900/60"
      style={{ width: pageWidth, height: pageHeight }}
    >
      {!pageReady ? (
        <div
          className="flex h-full w-full items-center justify-center text-sm text-zinc-500"
        >
          {t("pdf.loading")}
        </div>
      ) : null}
      <div ref={tilesHostRef} className="absolute inset-0" aria-hidden={!pageReady} />
      {pageReady && numPages > 0 ? (
        <span className="pointer-events-none absolute right-1 top-1 z-10 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white">
          {t("pdf.tiledView")}
        </span>
      ) : null}
    </div>
  );
}
