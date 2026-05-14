"use client";

import { useI18n } from "@/lib/i18n/LocaleProvider";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** (호환용) 예전 손가락 패닝 — 필기와 충돌 방지로 미사용 */
  navigationMode?: boolean;
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
   * 값이 바뀔 때 이동만 초기화(배율 유지). PDF 페이지 넘김 등.
   */
  panResetKey?: string | number;
  /** (호환용) 예전 Ink↔줌 브리지 — 제거됨 */
  touchBridgeRef?: unknown;
  /** true면 자식 영역을 뷰포트 높이까지 채움(전체화면+필기 시 캔버스 높이 확보). */
  stretchContent?: boolean;
};

const MIN_SCALE = 0.22;
const MAX_SCALE = 10;
const WHEEL_SCALE_STEP = 0.12;

/**
 * PDF/이미지 영역에 CSS transform 기반 확대·축소·이동.
 * 손가락 패닝/핀치는 제거(필기 캔버스와 포인터 경합 방지). 휠·버튼으로 배율 조절.
 */
export function ZoomPanSurface({
  children,
  className,
  onScaleChange,
  initialScale,
  viewResetKey,
  panResetKey,
  stretchContent = false,
}: Props) {
  const { t } = useI18n();
  const [scale, setScale] = useState(() => initialScale ?? 1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const clampScale = useCallback((s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)), []);

  const reset = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    onScaleChange?.(scale);
  }, [scale, onScaleChange]);

  useLayoutEffect(() => {
    if (viewResetKey === undefined) return;
    setScale(1);
    setPan({ x: 0, y: 0 });
    onScaleChange?.(1);
  }, [viewResetKey, onScaleChange]);

  useLayoutEffect(() => {
    if (panResetKey === undefined) return;
    setPan({ x: 0, y: 0 });
  }, [panResetKey]);

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
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 24) return;
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

  const ignorePenUi = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "pen") {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <div
      ref={viewportRef}
      className={["relative h-full min-h-0 w-full overflow-hidden", className ?? ""].join(" ")}
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
        className={[
          "flex h-full min-h-0 w-full touch-none",
          stretchContent ? "items-stretch justify-center" : "items-start justify-center",
        ].join(" ")}
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
