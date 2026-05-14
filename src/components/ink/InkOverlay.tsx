"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

type Point = { x: number; y: number };

export type InkTool = "draw" | "erase";

type Props = {
  storageKey: string;
  className?: string;
  strokeColor?: string;
  strokeWidth?: number;
  eraserRadius?: number;
  tool: InkTool;
  /** ZoomPanSurface CSS scale과 맞춰 캔버스 내부 해상도를 올림(확대 시 선명도). */
  viewportScale?: number;
};

export type Stroke = {
  color: string;
  width: number;
  points: Point[];
};

export type InkOverlayHandle = {
  clear: () => void;
  /** 부모 레이아웃·줌 변경 직후 캔버스 크기·좌표계 재동기화 */
  syncLayout: () => void;
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

function coalescedClientPoints(
  e: React.PointerEvent<HTMLCanvasElement>,
): ReadonlyArray<{ clientX: number; clientY: number }> {
  const ne = e.nativeEvent;
  if (ne instanceof PointerEvent && typeof ne.getCoalescedEvents === "function") {
    const c = ne.getCoalescedEvents();
    if (c.length > 0) return c;
  }
  return [e];
}

export const InkOverlay = forwardRef<InkOverlayHandle, Props>(function InkOverlay(
  {
    storageKey,
    className,
    strokeColor = "#2563eb",
    strokeWidth = 2.4,
    eraserRadius = 16,
    tool,
    viewportScale = 1,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);
  const activeDrawPointerId = useRef<number | null>(null);
  const eraserHoverRef = useRef<Point | null>(null);
  const [, bump] = useState(0);
  const lastAllocRef = useRef<{ cssW: number; cssH: number; dpr: number }>({
    cssW: 0,
    cssH: 0,
    dpr: 0,
  });
  const roRafRef = useRef<number | null>(null);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokesRef.current) {
      if (s.points.length === 0) continue;
      if (s.points.length === 1) {
        const p = s.points[0];
        const r = Math.max(0.6, s.width / 2);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
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
    if (currentRef.current) {
      const s = currentRef.current;
      if (s.points.length === 1) {
        const p = s.points[0];
        const r = Math.max(0.6, s.width / 2);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (s.points.length >= 2) {
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
    }
    if (tool === "erase" && eraserHoverRef.current) {
      const { x, y } = eraserHoverRef.current;
      ctx.save();
      ctx.fillStyle = "rgba(148, 163, 184, 0.28)";
      ctx.strokeStyle = "rgba(71, 85, 105, 0.75)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, eraserRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }, [tool, eraserRadius]);

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
    const pr = parent?.getBoundingClientRect();
    const cw0 = canvas.clientWidth;
    const ch0 = canvas.clientHeight;
    const w = Math.max(
      1,
      Math.round(
        cw0 > 0 ? cw0 : pr && pr.width > 0 ? pr.width : canvas.getBoundingClientRect().width || 1,
      ),
    );
    const h = Math.max(
      1,
      Math.round(
        ch0 > 0 ? ch0 : pr && pr.height > 0 ? pr.height : canvas.getBoundingClientRect().height || 1,
      ),
    );
    const base = window.devicePixelRatio || 1;
    const dpr = Math.min(5, Math.max(1, base * Math.max(1, viewportScale)));
    const last = lastAllocRef.current;
    if (last.cssW === w && last.cssH === h && last.dpr === dpr) return;
    lastAllocRef.current = { cssW: w, cssH: h, dpr };
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }, [redraw, viewportScale]);

  useEffect(() => {
    resizeToContainer();
    const ro = new ResizeObserver(() => {
      if (roRafRef.current != null) return;
      roRafRef.current = requestAnimationFrame(() => {
        roRafRef.current = null;
        resizeToContainer();
      });
    });
    const parent = canvasRef.current?.parentElement;
    if (parent) ro.observe(parent);
    return () => {
      ro.disconnect();
      if (roRafRef.current != null) {
        cancelAnimationFrame(roRafRef.current);
        roRafRef.current = null;
      }
    };
  }, [resizeToContainer, viewportScale]);

  useEffect(() => {
    currentRef.current = null;
    activeDrawPointerId.current = null;
    if (tool !== "erase") eraserHoverRef.current = null;
    redraw();
  }, [tool, redraw]);

  useImperativeHandle(
    ref,
    () => ({
      clear: () => {
        strokesRef.current = [];
        currentRef.current = null;
        activeDrawPointerId.current = null;
        eraserHoverRef.current = null;
        persist();
        redraw();
        bump((n) => n + 1);
      },
      syncLayout: () => {
        lastAllocRef.current = { cssW: 0, cssH: 0, dpr: 0 };
        resizeToContainer();
        bump((n) => n + 1);
      },
    }),
    [persist, redraw, resizeToContainer],
  );

  const clientPointFromClient = useCallback((clientX: number, clientY: number): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
    return { x, y };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      activeDrawPointerId.current = e.pointerId;

      if (tool === "erase") {
        currentRef.current = null;
        const p = clientPointFromClient(e.clientX, e.clientY);
        eraserHoverRef.current = p;
        const next = eraseStrokesAt(strokesRef.current, p.x, p.y, eraserRadius);
        if (next.length !== strokesRef.current.length) {
          strokesRef.current = next;
          persist();
          bump((n) => n + 1);
        }
        redraw();
        return;
      }

      eraserHoverRef.current = null;
      currentRef.current = {
        color: strokeColor,
        width: strokeWidth,
        points: [clientPointFromClient(e.clientX, e.clientY)],
      };
    },
    [tool, strokeColor, strokeWidth, eraserRadius, clientPointFromClient, persist, redraw],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (tool === "erase") {
        eraserHoverRef.current = clientPointFromClient(e.clientX, e.clientY);
        if (activeDrawPointerId.current === e.pointerId) {
          const list = coalescedClientPoints(e);
          let changed = false;
          for (const ev of list) {
            const p = clientPointFromClient(ev.clientX, ev.clientY);
            const next = eraseStrokesAt(strokesRef.current, p.x, p.y, eraserRadius);
            if (next.length !== strokesRef.current.length) {
              strokesRef.current = next;
              changed = true;
            }
          }
          if (changed) persist();
          redraw();
          if (changed) bump((n) => n + 1);
        } else {
          redraw();
        }
        return;
      }

      if (activeDrawPointerId.current !== e.pointerId) return;
      if (!currentRef.current) return;

      const minDist = Math.max(0.04, Math.min(0.85, strokeWidth * 0.065));
      const list = coalescedClientPoints(e);
      const pts = currentRef.current.points;
      for (const ev of list) {
        const p = clientPointFromClient(ev.clientX, ev.clientY);
        const last = pts.length > 0 ? pts[pts.length - 1] : null;
        if (last && distance(last, p) < minDist) continue;
        pts.push(p);
      }
      redraw();
    },
    [tool, strokeWidth, eraserRadius, clientPointFromClient, persist, redraw],
  );

  const endStroke = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (activeDrawPointerId.current !== e.pointerId) return;
      activeDrawPointerId.current = null;

      if (tool === "erase") {
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        redraw();
        return;
      }

      if (currentRef.current && currentRef.current.points.length >= 1) {
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
    },
    [tool, persist, redraw],
  );

  const onPointerLeave = useCallback(() => {
    eraserHoverRef.current = null;
    redraw();
  }, [redraw]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerUp={endStroke}
      onPointerCancel={endStroke}
    />
  );
});
