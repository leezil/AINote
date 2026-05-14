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
  /** true일 때 포인터로 이동·핀치 확대(필기 캔버스는 `pointer-events-none`으로 비활성화). */
  navigationMode: boolean;
  className?: string;
  /** 뷰포트 배율(예: PDF 캔버스 DPR 보정용). */
  onScaleChange?: (scale: number) => void;
  /** 마운트 시 복원할 배율(일반/전체화면별로 부모에서 주입). */
  initialScale?: number;
  /**
   * 값이 바뀔 때 확대·이동·배율을 초기화(문서 전환 등).
   */
  viewResetKey?: string | number;
  /**
   * 값이 바뀔 때 이동·핀치 세션만 초기화(배율 유지). PDF 페이지 넘김 등.
   */
  panResetKey?: string | number;
  /** 필기 레이어에서 손가락 패닝을 이 객체로 전달. */
  touchBridgeRef?: MutableRefObject<ZoomPanTouchBridge | null> | null;
  /** true면 자식 영역을 뷰포트 높이까지 채움(전체화면+필기 시 캔버스 높이 확보). */
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
 * iPad: 한 손가락 드래그 = 이동, 두 손가락 = 핀치 줌(navigationMode일 때만).
 */
export function ZoomPanSurface({
  children,
  navigationMode,
  className,
  onScaleChange,
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
  const pointers = useRef<Map<number, ReactPointerEvent>>(new Map());
  const pinchSession = useRef<PinchSession | null>(null);
  const panDrag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const clampScale = useCallback((s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)), []);

  const reset = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
    pinchSession.current = null;
    panDrag.current = null;
    pointers.current.clear();
  }, []);

  useEffect(() => {
    if (!navigationMode) {
      panDrag.current = null;
      pinchSession.current = null;
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
      },
    };
    touchBridgeRef.current = bridge;
    return () => {
      touchBridgeRef.current = null;
    };
  }, [touchBridgeRef, clampScale]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      const surface = el.querySelector("[data-zoom-document-surface]");
      if (!surface?.contains(t)) return;
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 24) return;
      e.preventDefault();
      const rect =
        surface instanceof Element ? surface.getBoundingClientRect() : el.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
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
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [clampScale]);

  const distance = (a: ReactPointerEvent, b: ReactPointerEvent) =>
    Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  /** PDF/필기 캔버스 등 — 여기서 시작한 포인터는 InkOverlay가 캡처·처리. 부모에서 잡으면 캡처를 빼앗아 필기가 막힘 */
  const eventTargetIsInsideDocumentSurface = (e: ReactPointerEvent<Element>) => {
    const t = e.target;
    if (!(t instanceof Element)) return false;
    return Boolean(t.closest("[data-zoom-document-surface]"));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!navigationMode) return;
    /** Apple Pencil 등은 필기 레이어에서 처리 */
    if (e.pointerType === "pen") return;
    if (eventTargetIsInsideDocumentSurface(e)) return;
    pointers.current.set(e.pointerId, e);
    const list = [...pointers.current.values()];
    if (list.length === 2) {
      const [a, b] = list;
      const d0 = distance(a, b);
      if (d0 > 8) {
        pinchSession.current = { d0, s0: scale };
      }
      panDrag.current = null;
    } else if (list.length === 1) {
      pinchSession.current = null;
      panDrag.current = { x: pan.x, y: pan.y, px: e.clientX, py: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!navigationMode) return;
    if (e.pointerType === "pen") return;
    if (eventTargetIsInsideDocumentSurface(e) && !pointers.current.has(e.pointerId)) return;
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
    } else if (list.length === 1 && panDrag.current && !pinchSession.current) {
      const d = panDrag.current;
      setPan({
        x: d.x + (e.clientX - d.px),
        y: d.y + (e.clientY - d.py),
      });
    }
  };

  const endPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!navigationMode) return;
    if (e.pointerType === "pen") return;
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchSession.current = null;
    if (pointers.current.size === 0) panDrag.current = null;
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
      className={[
        "relative h-full min-h-0 w-full overflow-hidden",
        navigationMode ? "touch-none cursor-grab active:cursor-grabbing" : "",
        className ?? "",
      ].join(" ")}
    >
      <div className="pointer-events-none absolute right-2 top-2 z-30 flex flex-col gap-1">
        <button
          type="button"
          className="pointer-events-auto rounded-md border border-zinc-300 bg-white/95 px-2 py-1 text-sm shadow dark:border-zinc-600 dark:bg-zinc-900/95"
          onPointerDown={ignorePenUi}
          onClick={() => setScale((s) => clampScale(s * 1.22))}
        >
          +
        </button>
        <button
          type="button"
          className="pointer-events-auto rounded-md border border-zinc-300 bg-white/95 px-2 py-1 text-sm shadow dark:border-zinc-600 dark:bg-zinc-900/95"
          onPointerDown={ignorePenUi}
          onClick={() => setScale((s) => clampScale(s / 1.22))}
        >
          −
        </button>
        <button
          type="button"
          className="pointer-events-auto rounded-md border border-zinc-300 bg-white/95 px-2 py-1 text-xs shadow dark:border-zinc-600 dark:bg-zinc-900/95"
          onPointerDown={ignorePenUi}
          onClick={reset}
        >
          {t("zoom.reset")}
        </button>
      </div>

      <div
        role="application"
        aria-label={t("zoom.regionAria")}
        className={[
          "flex h-full w-full min-h-0",
          stretchContent ? "items-stretch justify-center" : "items-start justify-center",
        ].join(" ")}
        onPointerDown={navigationMode ? onPointerDown : undefined}
        onPointerMove={navigationMode ? onPointerMove : undefined}
        onPointerUp={navigationMode ? endPointer : undefined}
        onPointerCancel={navigationMode ? endPointer : undefined}
      >
        <div
          className={[
            "will-change-transform max-h-full max-w-full min-h-0",
            stretchContent
              ? "flex h-full w-full justify-center"
              : "flex w-max min-h-0 max-h-full flex-col items-stretch",
          ].join(" ")}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transformOrigin: "center center",
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden" as const,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
