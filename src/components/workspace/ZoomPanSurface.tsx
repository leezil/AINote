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
  stretchContent?: boolean;
};

const MIN_SCALE = 0.22;
const MAX_SCALE = 10;
const WHEEL_SCALE_STEP = 0.12;

type PinchSession = {
  d0: number;
  s0: number;
};

/**
 * PDF/이미지 영역에 CSS transform 기반 확대·축소·이동.
 * `navigationMode`일 때만 포인터 패닝·핀치(필기 모드와 분리).
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
  stretchContent = false,
}: Props) {
  const { t } = useI18n();
  const [scale, setScale] = useState(() => initialScale ?? 1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const panRef = useRef(pan);
  panRef.current = pan;
  const touchDragRef = useRef<{ origX: number; origY: number; sx: number; sy: number } | null>(null);
  const pinchTouchRef = useRef<{ d0: number; s0: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pointers = useRef<Map<number, ReactPointerEvent<HTMLDivElement>>>(new Map());
  const pinchSession = useRef<PinchSession | null>(null);
  const panDrag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const clampScale = useCallback((s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)), []);

  const notifyScaleSettled = useCallback(() => {
    onScaleSettled?.(scaleRef.current);
  }, [onScaleSettled]);

  const cssScaleFactor = scale / Math.max(0.01, rasterCommitScale);

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
      beginPinch(d0: number) {
        pinchTouchRef.current = { d0, s0: scaleRef.current };
      },
      updatePinch(d1: number) {
        const p = pinchTouchRef.current;
        if (!p || p.d0 < 8 || d1 < 8) return;
        setScale(clampScale(p.s0 * (d1 / p.d0)));
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
  }, [touchBridgeRef, clampScale, notifyScaleSettled]);

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
      const mx = e.clientX - r.left - r.width / 2;
      const my = e.clientY - r.top - r.height / 2;
      const delta = -e.deltaY;
      setScale((prevS) => {
        const next = clampScale(prevS * (1 + (delta > 0 ? WHEEL_SCALE_STEP : -WHEEL_SCALE_STEP)));
        const ratio = next / prevS;
        setPan((p) => ({
          x: mx + (p.x - mx) * ratio,
          y: my + (p.y - my) * ratio,
        }));
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, true);
  }, [clampScale]);

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
        setScale(clampScale(ps.s0 * (d1 / ps.d0)));
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
    <div
      ref={viewportRef}
      className={["relative h-full min-h-0 w-full overflow-hidden overscroll-none", className ?? ""].join(" ")}
    >
      <div className="ainote-no-select pointer-events-none absolute right-2 top-2 z-30 flex select-none flex-col gap-1">
        <button
          type="button"
          className="pointer-events-auto select-none rounded-md border border-zinc-300 bg-white/95 px-2 py-1 text-sm shadow dark:border-zinc-600 dark:bg-zinc-900/95"
          onPointerDown={ignorePenUi}
          onClick={() => setScale((s) => clampScale(s * 1.22))}
        >
          +
        </button>
        <button
          type="button"
          className="pointer-events-auto select-none rounded-md border border-zinc-300 bg-white/95 px-2 py-1 text-sm shadow dark:border-zinc-600 dark:bg-zinc-900/95"
          onPointerDown={ignorePenUi}
          onClick={() => setScale((s) => clampScale(s / 1.22))}
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
          className={[
            "will-change-transform max-h-full max-w-full min-h-0",
            stretchContent
              ? "flex h-full w-full justify-center"
              : "flex w-max min-h-0 max-h-full flex-col items-stretch",
            navigationMode ? "pointer-events-none" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${cssScaleFactor})`,
            transformOrigin: "center center",
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
  );
}
