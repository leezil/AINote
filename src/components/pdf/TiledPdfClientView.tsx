"use client";

import { useI18n } from "@/lib/i18n/LocaleProvider";
import { useZoomPanTransform } from "@/components/workspace/ZoomPanTransformContext";
import { useFitDocumentWidth } from "@/lib/documents/zoomable-document";
import { PDF_PAGE_ASPECT_HEIGHT } from "@/lib/documents/pdf-render-quality";
import { ensurePdfJsWorker } from "@/lib/pdf/setup-pdfjs";
import {
  allTilesForPage,
  pageDimensions,
  tileDevicePixelRatio,
  visibleTilesForView,
  type TileSpec,
} from "@/lib/pdf/tile-render";
import { pdfjs } from "react-pdf";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

ensurePdfJsWorker();

type Props = {
  fileUrl: string;
  pageNumber: number;
  maxWidthPx?: number;
  wideMode?: boolean;
  onPdfLoaded?: (numPages: number) => void;
};

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (sched?.yield) {
      void sched.yield().then(resolve);
      return;
    }
    setTimeout(resolve, 0);
  });
}

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageReady, setPageReady] = useState(false);
  const [visiblePassDone, setVisiblePassDone] = useState(false);
  const [fullPassDone, setFullPassDone] = useState(false);

  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const pdfPageRef = useRef<PDFPageProxy | null>(null);
  const tileCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const renderGenRef = useRef(0);
  const renderingRef = useRef(false);
  const onPdfLoadedRef = useRef(onPdfLoaded);
  onPdfLoadedRef.current = onPdfLoaded;

  const transformRef = useRef(transform);
  transformRef.current = transform;

  const { pageWidth, pageHeight } = useMemo(
    () => pageDimensions(fitWidth, transform.scale, aspect),
    [fitWidth, transform.scale, aspect],
  );

  const pdfRenderScale = useMemo(() => {
    const vp1 = pdfPageRef.current?.getViewport({ scale: 1 });
    if (!vp1 || vp1.width <= 0) return transform.scale;
    return pageWidth / vp1.width;
  }, [pageWidth, transform.scale, pageReady]);

  const pdfRenderScaleRef = useRef(pdfRenderScale);
  pdfRenderScaleRef.current = pdfRenderScale;

  const pageSizeRef = useRef({ pageWidth, pageHeight });
  pageSizeRef.current = { pageWidth, pageHeight };

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setPageReady(false);
    setVisiblePassDone(false);
    setFullPassDone(false);
    tileCacheRef.current.clear();
    tilesHostRef.current?.replaceChildren();
    renderGenRef.current += 1;

    if (pdfDocRef.current) {
      void pdfDocRef.current.destroy();
      pdfDocRef.current = null;
    }
    pdfPageRef.current = null;

    void (async () => {
      try {
        const task = pdfjs.getDocument({ url: fileUrl, withCredentials: true });
        const doc = await task.promise;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        pdfDocRef.current = doc;
        onPdfLoadedRef.current?.(doc.numPages);

        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        pdfPageRef.current = page;
        const vp = page.getViewport({ scale: 1 });
        if (vp.width > 0) setAspect(vp.height / vp.width);
        setPageReady(true);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "load failed");
        }
      }
    })();

    return () => {
      cancelled = true;
      renderGenRef.current += 1;
      if (pdfDocRef.current) {
        void pdfDocRef.current.destroy();
        pdfDocRef.current = null;
      }
    };
  }, [fileUrl, pageNumber]);

  const collectVisibleTiles = useCallback((): TileSpec[] => {
    const vpEl = document.querySelector("[data-ainote-zoom-viewport]");
    const pageEl = pageRef.current;
    const { pageWidth: pw, pageHeight: ph } = pageSizeRef.current;
    if (!(vpEl instanceof HTMLElement) || !pageEl) return [];

    const vpRect = vpEl.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();

    return visibleTilesForView({
      viewportLeft: vpRect.left,
      viewportTop: vpRect.top,
      viewportWidth: vpRect.width,
      viewportHeight: vpRect.height,
      pageLeft: pageRect.left,
      pageTop: pageRect.top,
      pageWidth: pw,
      pageHeight: ph,
    });
  }, []);

  const mountTileCanvas = useCallback((spec: TileSpec, canvas: HTMLCanvasElement) => {
    const host = tilesHostRef.current;
    if (!host) return;
    const existing = host.querySelector(`[data-tile-key="${spec.key}"]`);
    if (existing) return;

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
  }, []);

  const renderTile = useCallback(async (spec: TileSpec, gen: number): Promise<boolean> => {
    const page = pdfPageRef.current;
    if (!page || gen !== renderGenRef.current) return false;

    if (tileCacheRef.current.has(spec.key)) {
      const cached = tileCacheRef.current.get(spec.key)!;
      mountTileCanvas(spec, cached);
      return true;
    }

    const pdfScale = pdfRenderScaleRef.current;
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
    if (!ctx) return false;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    try {
      await page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        transform: [1, 0, 0, 1, -spec.x, -spec.y],
      }).promise;
    } catch {
      return false;
    }

    if (gen !== renderGenRef.current) return false;

    tileCacheRef.current.set(spec.key, canvas);
    mountTileCanvas(spec, canvas);
    return true;
  }, [mountTileCanvas]);

  const runTwoPhaseRender = useCallback(async () => {
    if (!pageReady || renderingRef.current) return;
    renderingRef.current = true;
    const gen = renderGenRef.current;

    try {
      const visible = collectVisibleTiles();
      for (const spec of visible) {
        if (gen !== renderGenRef.current) return;
        await renderTile(spec, gen);
        await yieldToMain();
      }
      if (gen === renderGenRef.current) setVisiblePassDone(true);

      const { pageWidth: pw, pageHeight: ph } = pageSizeRef.current;
      const all = allTilesForPage(pw, ph);
      for (const spec of all) {
        if (gen !== renderGenRef.current) return;
        if (tileCacheRef.current.has(spec.key)) continue;
        await renderTile(spec, gen);
        await yieldToMain();
      }
      if (gen === renderGenRef.current) setFullPassDone(true);
    } finally {
      renderingRef.current = false;
    }
  }, [pageReady, collectVisibleTiles, renderTile]);

  const scheduleVisibleOnly = useCallback(() => {
    if (!pageReady) return;
    void (async () => {
      if (renderingRef.current) return;
      renderingRef.current = true;
      const gen = renderGenRef.current;
      try {
        const visible = collectVisibleTiles();
        for (const spec of visible) {
          if (gen !== renderGenRef.current) return;
          if (tileCacheRef.current.has(spec.key)) continue;
          await renderTile(spec, gen);
          await yieldToMain();
        }
      } finally {
        renderingRef.current = false;
      }
    })();
  }, [pageReady, collectVisibleTiles, renderTile]);

  useEffect(() => {
    if (!pageReady) return;
    renderGenRef.current += 1;
    tileCacheRef.current.clear();
    tilesHostRef.current?.replaceChildren();
    setVisiblePassDone(false);
    setFullPassDone(false);
    const id = requestAnimationFrame(() => {
      void runTwoPhaseRender();
    });
    return () => cancelAnimationFrame(id);
  }, [pageReady, pageWidth, pageHeight, pdfRenderScale, runTwoPhaseRender]);

  useEffect(() => {
    if (!pageReady) return;
    let raf = 0;
    const onPan = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => scheduleVisibleOnly());
    };
    onPan();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [
    pageReady,
    transform.panX,
    transform.panY,
    transform.viewportWidth,
    transform.viewportHeight,
    scheduleVisibleOnly,
  ]);

  useEffect(() => {
    if (!pageReady) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => scheduleVisibleOnly());
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [pageReady, scheduleVisibleOnly]);

  if (loadError) {
    return <p className="p-4 text-sm text-red-600">{t("pdf.error")}</p>;
  }

  return (
    <div
      ref={pageRef}
      data-pdf-page-box
      className="ainote-no-select relative inline-block shrink-0 overflow-hidden bg-zinc-100/80 dark:bg-zinc-900/60"
      style={{ width: pageWidth, height: pageHeight, touchAction: "none" }}
    >
      {!pageReady ? (
        <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
          {t("pdf.loading")}
        </div>
      ) : null}
      <div ref={tilesHostRef} className="absolute inset-0" aria-hidden={!pageReady} />
      {pageReady && !fullPassDone && visiblePassDone ? (
        <span className="pointer-events-none absolute left-1 top-1 z-10 rounded bg-black/45 px-1.5 py-0.5 text-[10px] text-white">
          {t("pdf.sharpening")}
        </span>
      ) : null}
      {pageReady ? (
        <span className="pointer-events-none absolute right-1 top-1 z-10 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white">
          {t("pdf.tiledView")}
        </span>
      ) : null}
    </div>
  );
}
