"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type MutableRefObject,
} from "react";

export type ZoomPanTouchBridge = {
  beginTouchPan: (clientX: number, clientY: number) => void;
  moveTouchPan: (clientX: number, clientY: number) => void;
  endTouchPan: () => void;
  beginPinch?: (distanceBetweenTouches: number) => void;
  updatePinch?: (distanceBetweenTouches: number) => void;
  endPinch?: () => void;
};

type Point = { x: number; y: number };

export type Stroke = {
  color: string;
  width: number;
  points: Point[];
};

export type InkOverlayHandle = {
  clear: () => void;
};

export type InkTool = "draw" | "erase";

type Props = {
  storageKey: string;
  className?: string;
  strokeColor?: string;
  strokeWidth?: number;
  eraserRadius?: number;
  tool: InkTool;
  /** 손가락(touch) 한 손 드래그를 뷰 이동으로 연결 (필기/지우개 모드에서 사용). */
  touchPanBridge?: MutableRefObject<ZoomPanTouchBridge | null> | null;
};

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointSegmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const nx = x1 + t * dx;
  const ny = y1 + t * dy;
  return Math.hypot(px - nx, py - ny);
}

function strokeHitByEraser(stroke: Stroke, px: number, py: number, eraserR: number): boolean {
  const pad = stroke.width / 2 + eraserR;
  for (const p of stroke.points) {
    if (Math.hypot(px - p.x, py - p.y) <= pad) return true;
  }
  for (let i = 1; i < stroke.points.length; i++) {
    const a = stroke.points[i - 1];
    const b = stroke.points[i];
    if (pointSegmentDistance(px, py, a.x, a.y, b.x, b.y) <= pad) return true;
  }
  return false;
}

function eraseStrokesAt(strokes: Stroke[], px: number, py: number, eraserR: number): Stroke[] {
  return strokes.filter((s) => !strokeHitByEraser(s, px, py, eraserR));
}

export const InkOverlay = forwardRef<InkOverlayHandle, Props>(function InkOverlay(
  {
    storageKey,
    className,
    strokeColor = "#2563eb",
    strokeWidth = 2.4,
    eraserRadius = 16,
    tool,
    touchPanBridge = null,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);
  const activeDrawPointerId = useRef<number | null>(null);
  const activeTouchPanId = useRef<number | null>(null);
  const touchCoordsRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchTouchActive = useRef(false);
  const [, bump] = useState(0);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokesRef.current) {
      if (s.points.length < 2) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(s.points[i].x, s.points[i].y);
      }
      ctx.stroke();
    }
    if (currentRef.current && currentRef.current.points.length >= 2) {
      const s = currentRef.current;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(s.points[i].x, s.points[i].y);
      }
      ctx.stroke();
    }
  }, []);

  const persist = useCallback(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(strokesRef.current));
    } catch {
      // ignore quota
    }
  }, [storageKey]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Stroke[];
        if (Array.isArray(parsed)) {
          strokesRef.current = parsed;
          bump((n) => n + 1);
          queueMicrotask(redraw);
        }
      }
    } catch {
      // ignore
    }
  }, [storageKey, redraw]);

  const resizeToContainer = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }, [redraw]);

  useEffect(() => {
    resizeToContainer();
    const ro = new ResizeObserver(() => resizeToContainer());
    const parent = canvasRef.current?.parentElement;
    if (parent) ro.observe(parent);
    return () => ro.disconnect();
  }, [resizeToContainer]);

  useEffect(() => {
    currentRef.current = null;
    activeDrawPointerId.current = null;
    redraw();
  }, [tool, redraw]);

  useImperativeHandle(
    ref,
    () => ({
      clear: () => {
        strokesRef.current = [];
        currentRef.current = null;
        activeDrawPointerId.current = null;
        activeTouchPanId.current = null;
        touchCoordsRef.current.clear();
        pinchTouchActive.current = false;
        persist();
        redraw();
        bump((n) => n + 1);
      },
    }),
    [persist, redraw],
  );

  const clientPoint = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "touch") {
      if (!touchPanBridge?.current) return;
      e.preventDefault();
      touchCoordsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (touchCoordsRef.current.size >= 2) {
        if (activeTouchPanId.current !== null) {
          const pid = activeTouchPanId.current;
          touchPanBridge.current.endTouchPan();
          activeTouchPanId.current = null;
          try {
            e.currentTarget.releasePointerCapture(pid);
          } catch {
            // ignore
          }
        }
        const d0 = (() => {
          const pts = [...touchCoordsRef.current.values()];
          if (pts.length < 2) return 0;
          return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        })();
        if (d0 > 8) {
          pinchTouchActive.current = true;
          touchPanBridge.current.beginPinch?.(d0);
        }
        return;
      }

      e.currentTarget.setPointerCapture(e.pointerId);
      activeTouchPanId.current = e.pointerId;
      touchPanBridge.current.beginTouchPan(e.clientX, e.clientY);
      return;
    }

    if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    activeDrawPointerId.current = e.pointerId;

    if (tool === "erase") {
      currentRef.current = null;
      const p = clientPoint(e);
      const next = eraseStrokesAt(strokesRef.current, p.x, p.y, eraserRadius);
      if (next.length !== strokesRef.current.length) {
        strokesRef.current = next;
        persist();
        redraw();
        bump((n) => n + 1);
      }
      return;
    }

    currentRef.current = {
      color: strokeColor,
      width: strokeWidth,
      points: [clientPoint(e)],
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "touch") {
      if (touchCoordsRef.current.has(e.pointerId)) {
        touchCoordsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (pinchTouchActive.current && touchCoordsRef.current.size >= 2) {
        const pts = [...touchCoordsRef.current.values()];
        const d1 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        touchPanBridge?.current?.updatePinch?.(d1);
        return;
      }
      if (activeTouchPanId.current === e.pointerId && touchCoordsRef.current.size === 1) {
        touchPanBridge?.current?.moveTouchPan(e.clientX, e.clientY);
      }
      return;
    }

    if (activeDrawPointerId.current !== e.pointerId) return;

    if (tool === "erase") {
      const p = clientPoint(e);
      const next = eraseStrokesAt(strokesRef.current, p.x, p.y, eraserRadius);
      if (next.length !== strokesRef.current.length) {
        strokesRef.current = next;
        persist();
        redraw();
        bump((n) => n + 1);
      }
      return;
    }

    if (!currentRef.current) return;
    const p = clientPoint(e);
    const pts = currentRef.current.points;
    const last = pts.length > 0 ? pts[pts.length - 1] : null;
    if (last && distance(last, p) < 0.35) return;
    pts.push(p);
    redraw();
  };

  const endStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "touch") {
      touchCoordsRef.current.delete(e.pointerId);
      if (touchCoordsRef.current.size < 2) {
        if (pinchTouchActive.current) {
          pinchTouchActive.current = false;
          touchPanBridge?.current?.endPinch?.();
        }
      }
      if (activeTouchPanId.current === e.pointerId) {
        activeTouchPanId.current = null;
        touchPanBridge?.current?.endTouchPan();
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
      return;
    }

    if (activeDrawPointerId.current !== e.pointerId) return;
    activeDrawPointerId.current = null;

    if (tool === "erase") {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      return;
    }

    if (currentRef.current && currentRef.current.points.length > 1) {
      strokesRef.current.push(currentRef.current);
      persist();
    }
    currentRef.current = null;
    redraw();
    bump((n) => n + 1);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endStroke}
      onPointerCancel={endStroke}
    />
  );
});
