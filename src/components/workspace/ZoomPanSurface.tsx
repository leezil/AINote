"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

type Props = {
  children: ReactNode;
  /** true일 때 포인터로 이동·핀치 확대(필기 캔버스는 `pointer-events-none`으로 비활성화). */
  navigationMode: boolean;
  className?: string;
  /** 뷰포트 배율(예: PDF 캔버스 DPR 보정용). */
  onScaleChange?: (scale: number) => void;
  /**
   * 값이 바뀔 때 확대·이동을 초기화. 페이지/전체화면 전환 후 이전 pan 때문에 화면 밖으로 밀린 것처럼
   * 보이는 문제를 막기 위해 사용.
   */
  viewResetKey?: string | number;
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
  viewResetKey,
}: Props) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
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
    onScaleChange?.(1);
  }, [viewResetKey, onScaleChange]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 24) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
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

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!navigationMode) return;
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
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchSession.current = null;
    if (pointers.current.size === 0) panDrag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
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
          onClick={() => setScale((s) => clampScale(s * 1.22))}
        >
          +
        </button>
        <button
          type="button"
          className="pointer-events-auto rounded-md border border-zinc-300 bg-white/95 px-2 py-1 text-sm shadow dark:border-zinc-600 dark:bg-zinc-900/95"
          onClick={() => setScale((s) => clampScale(s / 1.22))}
        >
          −
        </button>
        <button
          type="button"
          className="pointer-events-auto rounded-md border border-zinc-300 bg-white/95 px-2 py-1 text-xs shadow dark:border-zinc-600 dark:bg-zinc-900/95"
          onClick={reset}
        >
          초기화
        </button>
      </div>

      <div
        role="application"
        aria-label="확대 및 이동 영역"
        className="flex h-full w-full items-center justify-center"
        onPointerDown={navigationMode ? onPointerDown : undefined}
        onPointerMove={navigationMode ? onPointerMove : undefined}
        onPointerUp={navigationMode ? endPointer : undefined}
        onPointerCancel={navigationMode ? endPointer : undefined}
      >
        <div
          className="will-change-transform"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transformOrigin: "center center",
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
