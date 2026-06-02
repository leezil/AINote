"use client";

import { useI18n } from "@/lib/i18n/LocaleProvider";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { ZoomPanTouchBridge } from "@/components/ink/InkOverlay";
import { ZoomPanViewportWidthContext } from "@/components/workspace/ZoomPanViewportWidthContext";
import {
  ZoomPanTransformContext,
  type ZoomPanTransform,
} from "@/components/workspace/ZoomPanTransformContext";
import { prefersTouchGestureNavigation } from "@/lib/device/ink-input-profile";

type Props = {
  children: ReactNode;
  navigationMode?: boolean;
  className?: string;
  onScaleChange?: (scale: number) => void;
  /** 핀치·드래그·휠이 끝났을 때 — PDF 래스터를 즉시 맞출 때 사용 */
  onScaleSettled?: (scale: number) => void;
  /** PDF 등이 이미 `committedScale` 배율로 그려졌을 때 CSS에만 남길 추가 배율 (gesture/committed) */
  rasterCommitScale?: number;
  initialScale?: number;
  viewResetKey?: string | number;
  panResetKey?: string | number;
  /** InkOverlay에서 손가락 패닝·핀치를 이 객체로 전달 */
  touchBridgeRef?: MutableRefObject<ZoomPanTouchBridge | null> | null;
  /** 뷰포트 너비 — 래스터 상한·CSS 배율 계산용 */
  onViewportWidthChange?: (widthPx: number) => void;
  /** 제스처 확대 상한(래스터 한도). 초과 시 확대 불가 — 흰 화면·CSS 과확대 방지 */
  maxGestureScale?: number;
  /** true: CSS scale 없이 문서 레이아웃 크기로 확대(타일 PDF) */
  layoutZoomMode?: boolean;
  stretchContent?: boolean;
};

const MIN_SCALE = 0.22;
const MAX_SCALE = 10;
const WHEEL_SCALE_STEP = 0.12;
const WHEEL_SETTLE_MS = 280;
const SETTLE_EPSILON = 0.02;

type PinchSession = {
  d0: number;
  s0: number;
};

/**
 * PDF/이미지 영역에 CSS transform 기반 확대·축소·이동.
 * `navigationMode`일 때 포인터(마우스) 패닝·핀치. 터치 패닝·핀치는 InkOverlay→touchBridge.
 */
export function ZoomPanSurface({
  children,
  navigationMode = false,
  className,
  onScaleChange,
  onScaleSettled,
  rasterCommitScale = 1,
  initialScale,
  viewResetKey,
  panResetKey,
  touchBridgeRef,
  onViewportWidthChange,
  maxGestureScale,
  layoutZoomMode = false,
  stretchContent = false,
}: Props) {
  const { t } = useI18n();
  const [scale, setScale] = useState(() => initialScale ?? 1);
  const [viewportWidth, setViewportWidth] = useState(960);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const panRef = useRef(pan);
  panRef.current = pan;
  const touchDragRef = useRef<{ origX: number; origY: number; sx: number; sy: number } | null>(null);
  const pinchTouchRef = useRef<{ d0: number; s0: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const transformLayerRef = useRef<HTMLDivElement | null>(null);
  const prevRasterCommitRef = useRef(rasterCommitScale);
  /** 선명도 커밋 시 패닝 보정 — 마지막 확대·축소 손가락/포인터 위치 */
  const lastZoomFocalRef = useRef<{ x: number; y: number } | null>(null);
  const pointers = useRef<Map<number, ReactPointerEvent<HTMLDivElement>>>(new Map());
  const pinchSession = useRef<PinchSession | null>(null);
  const panDrag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const gestureMaxRef = useRef(maxGestureScale ?? MAX_SCALE);
  gestureMaxRef.current = maxGestureScale ?? MAX_SCALE;

  const clampScale = useCallback((s: number) => {
    const cap = Math.min(MAX_SCALE, gestureMaxRef.current);
    return Math.max(MIN_SCALE, Math.min(cap, s));
  }, []);

  useEffect(() => {
    setScale((s) => clampScale(s));
  }, [maxGestureScale, clampScale]);

  const lastSettledScaleRef = useRef(scale);
  const wheelSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notifyScaleSettled = useCallback(() => {
    const s = scaleRef.current;
    if (Math.abs(s - lastSettledScaleRef.current) < SETTLE_EPSILON) return;
    lastSettledScaleRef.current = s;
    onScaleSettled?.(s);
  }, [onScaleSettled]);

  const cssScaleFactor = layoutZoomMode
    ? 1
    : scale / Math.max(0.01, rasterCommitScale);

  const applyZoomAtClient = useCallback(
    (newScale: number, clientX: number, clientY: number) => {
      const layer = transformLayerRef.current;
      const next = clampScale(newScale);
      const old = scaleRef.current;
      if (!layer) {
        setScale(next);
        return;
      }
      const ratio = next / old;
      if (Math.abs(ratio - 1) < 0.0001) return;

      lastZoomFocalRef.current = { x: clientX, y: clientY };

      const rect = layer.getBoundingClientRect();
      const fx = layoutZoomMode
        ? clientX - rect.left
        : clientX - (rect.left + rect.width / 2);
      const fy = layoutZoomMode
        ? clientY - rect.top
        : clientY - (rect.top + rect.height / 2);

      setPan((p) => ({
        x: p.x + fx * (1 - ratio),
        y: p.y + fy * (1 - ratio),
      }));
      setScale(next);
    },
    [clampScale, layoutZoomMode],
  );

  const viewportCenterClient = useCallback((): { x: number; y: number } => {
    const vp = viewportRef.current?.getBoundingClientRect();
    if (!vp) return { x: 0, y: 0 };
    return { x: vp.left + vp.width / 2, y: vp.top + vp.height / 2 };
  }, []);

  const reset = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
    pinchSession.current = null;
    panDrag.current = null;
    pointers.current.clear();
    touchDragRef.current = null;
    pinchTouchRef.current = null;
  }, []);

  useEffect(() => {
    if (!navigationMode) {
      panDrag.current = null;
      pinchSession.current = null;
      pointers.current.clear();
      touchDragRef.current = null;
      pinchTouchRef.current = null;
    }
  }, [navigationMode]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w >= 64) {
        setViewportWidth(w);
        onViewportWidthChange?.(w);
      }
      if (h >= 64) setViewportHeight(h);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [onViewportWidthChange]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const blockGesture = (e: Event) => e.preventDefault();
    el.addEventListener("gesturestart", blockGesture, { passive: false });
    el.addEventListener("gesturechange", blockGesture, { passive: false });
    el.addEventListener("gestureend", blockGesture, { passive: false });
    return () => {
      el.removeEventListener("gesturestart", blockGesture);
      el.removeEventListener("gesturechange", blockGesture);
      el.removeEventListener("gestureend", blockGesture);
    };
  }, []);

  useEffect(() => {
    onScaleChange?.(scale);
  }, [scale, onScaleChange]);

  useLayoutEffect(() => {
    if (viewResetKey === undefined) return;
    setScale(1);
    setPan({ x: 0, y: 0 });
    pinchSession.current = null;
    panDrag.current = null;
    pointers.current.clear();
    touchDragRef.current = null;
    pinchTouchRef.current = null;
    lastSettledScaleRef.current = 1;
    onScaleChange?.(1);
  }, [viewResetKey, onScaleChange]);

  useLayoutEffect(() => {
    if (panResetKey === undefined) return;
    setPan({ x: 0, y: 0 });
    pinchSession.current = null;
    panDrag.current = null;
    pointers.current.clear();
    touchDragRef.current = null;
    pinchTouchRef.current = null;
  }, [panResetKey]);

  /** 선명도 커밋 시 레이아웃이 바뀌어도 화면 중앙이 튀지 않도록 패닝 보정 */
  useLayoutEffect(() => {
    if (layoutZoomMode) return;
    const prev = prevRasterCommitRef.current;
    const next = rasterCommitScale;
    prevRasterCommitRef.current = next;
    if (Math.abs(next - prev) < 0.02) return;

    const layer = transformLayerRef.current;
    if (!layer) return;

    const cssRatio = prev / next;
    if (Math.abs(cssRatio - 1) < 0.02) return;

    const focal = lastZoomFocalRef.current ?? viewportCenterClient();
    const rect = layer.getBoundingClientRect();
    const fx = focal.x - (rect.left + rect.width / 2);
    const fy = focal.y - (rect.top + rect.height / 2);

    setPan((p) => ({
      x: p.x + fx * (1 - cssRatio),
      y: p.y + fy * (1 - cssRatio),
    }));
  }, [rasterCommitScale, viewportCenterClient, layoutZoomMode]);

  const transformSnapshot: ZoomPanTransform = {
    scale,
    panX: pan.x,
    panY: pan.y,
    viewportWidth,
    viewportHeight,
  };

  useEffect(() => {
    if (!touchBridgeRef) return;
    const bridge: ZoomPanTouchBridge = {
      beginTouchPan(clientX: number, clientY: number) {
        const p = panRef.current;
        touchDragRef.current = { origX: p.x, origY: p.y, sx: clientX, sy: clientY };
      },
      moveTouchPan(clientX: number, clientY: number) {
        const d = touchDragRef.current;
        if (!d) return;
        setPan({
          x: d.origX + (clientX - d.sx),
          y: d.origY + (clientY - d.sy),
        });
      },
      endTouchPan() {
        touchDragRef.current = null;
      },
      beginPinch(d0: number, _centerX: number, _centerY: number) {
        pinchTouchRef.current = { d0, s0: scaleRef.current };
      },
      updatePinch(d1: number, centerX: number, centerY: number) {
        const p = pinchTouchRef.current;
        if (!p || p.d0 < 8 || d1 < 8) return;
        applyZoomAtClient(clampScale(p.s0 * (d1 / p.d0)), centerX, centerY);
      },
      endPinch() {
        pinchTouchRef.current = null;
        notifyScaleSettled();
      },
    };
    touchBridgeRef.current = bridge;
    return () => {
      touchBridgeRef.current = null;
    };
  }, [touchBridgeRef, clampScale, notifyScaleSettled, applyZoomAtClient]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const surface = el.querySelector("[data-zoom-document-surface]");
      if (!(surface instanceof Element)) return;
      const r = surface.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      ) {
        return;
      }
      e.preventDefault();

      const touchNav = prefersTouchGestureNavigation();
      if (touchNav && !e.ctrlKey) {
        return;
      }

      const delta = -e.deltaY;
      const { x: cx, y: cy } = viewportCenterClient();
      applyZoomAtClient(
        clampScale(scaleRef.current * (1 + (delta > 0 ? WHEEL_SCALE_STEP : -WHEEL_SCALE_STEP))),
        cx,
        cy,
      );
      if (wheelSettleTimerRef.current != null) {
        clearTimeout(wheelSettleTimerRef.current);
      }
      wheelSettleTimerRef.current = setTimeout(() => {
        wheelSettleTimerRef.current = null;
        notifyScaleSettled();
      }, WHEEL_SETTLE_MS);
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => {
      el.removeEventListener("wheel", onWheel, true);
      if (wheelSettleTimerRef.current != null) {
        clearTimeout(wheelSettleTimerRef.current);
      }
    };
  }, [clampScale, notifyScaleSettled, applyZoomAtClient, viewportCenterClient]);

  const distance = (a: ReactPointerEvent<HTMLDivElement>, b: ReactPointerEvent<HTMLDivElement>) =>
    Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!navigationMode) return;
    pointers.current.set(e.pointerId, e);
    const list = [...pointers.current.values()];
    if (list.length === 2) {
      const [a, b] = list;
      const d0 = distance(a, b);
      if (d0 > 8) {
        pinchSession.current = { d0, s0: scaleRef.current };
      }
      panDrag.current = null;
    } else if (list.length === 1) {
      pinchSession.current = null;
      const p = panRef.current;
      panDrag.current = { x: p.x, y: p.y, px: e.clientX, py: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!navigationMode) return;
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, e);
    const list = [...pointers.current.values()];

    if (list.length === 2 && pinchSession.current) {
      const [a, b] = list;
      const d1 = distance(a, b);
      const ps = pinchSession.current;
      if (d1 > 8 && ps.d0 > 8) {
        const cx = (a.clientX + b.clientX) / 2;
        const cy = (a.clientY + b.clientY) / 2;
        applyZoomAtClient(clampScale(ps.s0 * (d1 / ps.d0)), cx, cy);
      }
      panDrag.current = null;
    } else if (list.length === 1) {
      if (!panDrag.current) {
        const p = panRef.current;
        const ev = list[0];
        panDrag.current = { x: p.x, y: p.y, px: ev.clientX, py: ev.clientY };
      }
      if (pinchSession.current) {
        pinchSession.current = null;
      }
      const d = panDrag.current;
      if (d) {
        const ev = list[0];
        setPan({
          x: d.x + (ev.clientX - d.px),
          y: d.y + (ev.clientY - d.py),
        });
      }
    }
  };

  const endPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!navigationMode) return;
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);

    if (pointers.current.size < 2) {
      pinchSession.current = null;
    }

    if (pointers.current.size === 1) {
      const remaining = [...pointers.current.values()][0];
      const p = panRef.current;
      panDrag.current = {
        x: p.x,
        y: p.y,
        px: remaining.clientX,
        py: remaining.clientY,
      };
      try {
        e.currentTarget.setPointerCapture(remaining.pointerId);
      } catch {
        // ignore
      }
    } else if (pointers.current.size === 0) {
      panDrag.current = null;
      notifyScaleSettled();
    }

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const ignorePenUi = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "pen") {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <ZoomPanTransformContext.Provider value={transformSnapshot}>
    <ZoomPanViewportWidthContext.Provider value={viewportWidth}>
    <div
      ref={viewportRef}
      data-ainote-zoom-viewport
      className={["relative h-full min-h-0 w-full overflow-hidden overscroll-none", className ?? ""].join(" ")}
    >
      <div className="ainote-no-select pointer-events-none absolute right-2 top-2 z-30 flex select-none flex-col gap-1">
        <button
          type="button"
          className="pointer-events-auto select-none rounded-md border border-zinc-300 bg-white/95 px-2 py-1 text-sm shadow dark:border-zinc-600 dark:bg-zinc-900/95"
          onPointerDown={ignorePenUi}
          onClick={() => {
            const { x, y } = viewportCenterClient();
            applyZoomAtClient(clampScale(scaleRef.current * 1.22), x, y);
          }}
        >
          +
        </button>
        <button
          type="button"
          className="pointer-events-auto select-none rounded-md border border-zinc-300 bg-white/95 px-2 py-1 text-sm shadow dark:border-zinc-600 dark:bg-zinc-900/95"
          onPointerDown={ignorePenUi}
          onClick={() => {
            const { x, y } = viewportCenterClient();
            applyZoomAtClient(clampScale(scaleRef.current / 1.22), x, y);
          }}
        >
          −
        </button>
        <button
          type="button"
          className="pointer-events-auto select-none rounded-md border border-zinc-300 bg-white/95 px-2 py-1 text-xs shadow dark:border-zinc-600 dark:bg-zinc-900/95"
          onPointerDown={ignorePenUi}
          onClick={reset}
        >
          {t("zoom.reset")}
        </button>
      </div>

      <div
        className={[
          "relative flex h-full min-h-0 w-full touch-none",
          stretchContent ? "items-stretch justify-center" : "items-start justify-center",
        ].join(" ")}
      >
        <div
          ref={transformLayerRef}
          className={[
            "will-change-transform shrink-0",
            stretchContent
              ? "flex h-full w-full justify-center"
              : "inline-flex w-max max-w-none flex-col items-stretch",
            navigationMode ? "pointer-events-none" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${cssScaleFactor})`,
            transformOrigin: layoutZoomMode ? "0 0" : "center center",
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden" as const,
          }}
        >
          {children}
        </div>

        {navigationMode ? (
          <div
            role="application"
            aria-label={t("zoom.regionAria")}
            className="absolute inset-0 z-[15] touch-none cursor-grab active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
          />
        ) : null}
      </div>
    </div>
    </ZoomPanViewportWidthContext.Provider>
    </ZoomPanTransformContext.Provider>
  );
}
