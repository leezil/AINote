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

import {
  inkDebugLog,
  inkPointerDiagnostics,
  isLikelyStylusAsTouch,
  readInkDebugFlag,
} from "@/lib/inkDebug";

export type ZoomPanTouchBridge = {
  beginTouchPan: (clientX: number, clientY: number) => void;
  moveTouchPan: (clientX: number, clientY: number) => void;
  endTouchPan: () => void;
  beginPinch?: (distanceBetweenTouches: number) => void;
  updatePinch?: (distanceBetweenTouches: number) => void;
  endPinch?: () => void;
};

type Point = { x: number; y: number };

export type InkTool = "draw" | "erase";

type RemoteInkConfig = {
  documentId: string;
  page: number | null;
  headers: HeadersInit;
};

type Props = {
  storageKey: string;
  /** 서버에 필기 동기화(워크스페이스 Blob/로컬 스토어). 없으면 localStorage만 사용 */
  remoteInk?: RemoteInkConfig | null;
  className?: string;
  strokeColor?: string;
  strokeWidth?: number;
  eraserRadius?: number;
  tool: InkTool;
  /** ZoomPanSurface CSS scale — 캔버스 DPR 보정 */
  viewportScale?: number;
  /**
   * false(기본): 펜·마우스만 필기. 손가락(touch)은 `touchPanBridge`로만 패닝·핀치(필기 모드일 때).
   * true: 손가락으로도 필기.
   */
  allowFingerInk?: boolean;
  /** 손가락 한 손 드래그·두 손 핀치를 뷰 이동·확대와 연결 */
  touchPanBridge?: MutableRefObject<ZoomPanTouchBridge | null> | null;
  /** 실행 취소·다시 실행 버튼 등을 갱신 */
  onInkHistoryChange?: () => void;
};

export type Stroke = {
  color: string;
  width: number;
  points: Point[];
};

export type InkOverlayHandle = {
  clear: () => void;
  syncLayout: () => void;
  undo: () => boolean;
  redo: () => boolean;
  canUndo: () => boolean;
  canRedo: () => boolean;
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

const MAX_INK_UNDO = 64;

function cloneStrokes(s: Stroke[]): Stroke[] {
  return s.map((st) => ({
    color: st.color,
    width: st.width,
    points: st.points.map((p) => ({ x: p.x, y: p.y })),
  }));
}

function trimStack<T>(arr: T[], max: number) {
  while (arr.length > max) arr.shift();
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
    remoteInk = null,
    className,
    strokeColor = "#2563eb",
    strokeWidth = 2.4,
    eraserRadius = 16,
    tool,
    viewportScale = 1,
    allowFingerInk = false,
    touchPanBridge = null,
    onInkHistoryChange,
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
  const eraserHoverRef = useRef<Point | null>(null);
  const [, bump] = useState(0);
  const lastAllocRef = useRef<{ cssW: number; cssH: number; dpr: number }>({
    cssW: 0,
    cssH: 0,
    dpr: 0,
  });
  const roRafRef = useRef<number | null>(null);
  const moveDebugUntilRef = useRef(0);
  const ignoredEndLogUntilRef = useRef(0);
  const remoteInkRef = useRef(remoteInk);
  remoteInkRef.current = remoteInk;
  const remoteSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inkLoadGenRef = useRef(0);
  const undoStackRef = useRef<Stroke[][]>([]);
  const redoStackRef = useRef<Stroke[][]>([]);
  const eraseGestureUndoPushedRef = useRef(false);
  const onInkHistoryChangeRef = useRef(onInkHistoryChange);
  onInkHistoryChangeRef.current = onInkHistoryChange;

  const notifyInkHistory = useCallback(() => {
    onInkHistoryChangeRef.current?.();
  }, []);

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

  const putInkRemote = useCallback((remote: RemoteInkConfig, strokes: Stroke[]) => {
    const q = remote.page != null ? `?page=${remote.page}` : "";
    const body =
      remote.page != null
        ? JSON.stringify({ page: remote.page, strokes })
        : JSON.stringify({ strokes });
    return fetch(`/api/documents/${remote.documentId}/ink${q}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...remote.headers },
      body,
    });
  }, []);

  const persist = useCallback(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(strokesRef.current));
    } catch {
      // ignore quota
    }
    const remote = remoteInkRef.current;
    if (!remote) return;
    if (remoteSaveTimerRef.current != null) {
      clearTimeout(remoteSaveTimerRef.current);
    }
    remoteSaveTimerRef.current = setTimeout(() => {
      remoteSaveTimerRef.current = null;
      void putInkRemote(remote, strokesRef.current).catch(() => {});
    }, 650);
  }, [storageKey, putInkRemote]);

  const pushUndoSnapshot = useCallback(
    (snapshot: Stroke[]) => {
      undoStackRef.current.push(snapshot);
      trimStack(undoStackRef.current, MAX_INK_UNDO);
      redoStackRef.current.length = 0;
      notifyInkHistory();
    },
    [notifyInkHistory],
  );

  const applyUndo = useCallback(() => {
    if (undoStackRef.current.length === 0) return false;
    redoStackRef.current.push(cloneStrokes(strokesRef.current));
    trimStack(redoStackRef.current, MAX_INK_UNDO);
    strokesRef.current = cloneStrokes(undoStackRef.current.pop()!);
    persist();
    redraw();
    bump((n) => n + 1);
    notifyInkHistory();
    return true;
  }, [persist, redraw, notifyInkHistory]);

  const applyRedo = useCallback(() => {
    if (redoStackRef.current.length === 0) return false;
    undoStackRef.current.push(cloneStrokes(strokesRef.current));
    trimStack(undoStackRef.current, MAX_INK_UNDO);
    strokesRef.current = cloneStrokes(redoStackRef.current.pop()!);
    persist();
    redraw();
    bump((n) => n + 1);
    notifyInkHistory();
    return true;
  }, [persist, redraw, notifyInkHistory]);

  useEffect(() => {
    const remote = remoteInk ?? null;
    const gen = ++inkLoadGenRef.current;
    currentRef.current = null;
    activeDrawPointerId.current = null;
    activeTouchPanId.current = null;
    touchCoordsRef.current.clear();
    pinchTouchActive.current = false;
    eraserHoverRef.current = null;
    strokesRef.current = [];
    undoStackRef.current = [];
    redoStackRef.current = [];
    eraseGestureUndoPushedRef.current = false;
    notifyInkHistory();

    const applyLocalFallback = () => {
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as Stroke[];
          if (Array.isArray(parsed)) strokesRef.current = parsed;
        }
      } catch {
        strokesRef.current = [];
      }
    };

    if (!remote) {
      applyLocalFallback();
      bump((n) => n + 1);
      queueMicrotask(redraw);
      notifyInkHistory();
      return () => {
        if (remoteSaveTimerRef.current != null) {
          clearTimeout(remoteSaveTimerRef.current);
          remoteSaveTimerRef.current = null;
        }
      };
    }

    let cancelled = false;
    const q = remote.page != null ? `?page=${remote.page}` : "";
    void (async () => {
      try {
        const res = await fetch(`/api/documents/${remote.documentId}/ink${q}`, {
          headers: remote.headers,
          cache: "no-store",
        });
        if (cancelled || gen !== inkLoadGenRef.current) return;
        if (res.ok) {
          const data = (await res.json()) as { strokes?: unknown };
          const arr = data.strokes;
          if (Array.isArray(arr)) {
            strokesRef.current = arr as Stroke[];
            try {
              localStorage.setItem(storageKey, JSON.stringify(strokesRef.current));
            } catch {
              // ignore
            }
            bump((n) => n + 1);
            queueMicrotask(redraw);
            notifyInkHistory();
            return;
          }
        }
      } catch {
        // fall through
      }
      if (cancelled || gen !== inkLoadGenRef.current) return;
      applyLocalFallback();
      bump((n) => n + 1);
      queueMicrotask(redraw);
      notifyInkHistory();
    })();

    return () => {
      cancelled = true;
      if (remoteSaveTimerRef.current != null) {
        clearTimeout(remoteSaveTimerRef.current);
        remoteSaveTimerRef.current = null;
      }
      void putInkRemote(remote, strokesRef.current).catch(() => {});
    };
  }, [storageKey, redraw, remoteInk, putInkRemote, notifyInkHistory]);

  const resizeToContainer = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const surface = canvas.closest("[data-zoom-document-surface]") as HTMLElement | null;
    let w: number;
    let h: number;
    if (surface) {
      w = Math.max(1, Math.round(surface.clientWidth));
      h = Math.max(1, Math.round(surface.clientHeight));
    } else {
      const parent = canvas.parentElement;
      const pw = parent?.clientWidth ?? 0;
      const ph = parent?.clientHeight ?? 0;
      const pr = parent?.getBoundingClientRect();
      const cw0 = canvas.clientWidth;
      const ch0 = canvas.clientHeight;
      w = Math.max(
        1,
        Math.round(
          cw0 > 0
            ? cw0
            : pw > 0
              ? pw
              : pr && pr.width > 0
                ? pr.width
                : canvas.getBoundingClientRect().width || 1,
        ),
      );
      h = Math.max(
        1,
        Math.round(
          ch0 > 0
            ? ch0
            : ph > 0
              ? ph
              : pr && pr.height > 0
                ? pr.height
                : canvas.getBoundingClientRect().height || 1,
        ),
      );
    }
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
    const surface = canvasRef.current?.closest("[data-zoom-document-surface]") as HTMLElement | null;
    const roTarget = surface ?? canvasRef.current?.parentElement;
    if (roTarget) ro.observe(roTarget);
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
    activeTouchPanId.current = null;
    touchCoordsRef.current.clear();
    pinchTouchActive.current = false;
    eraseGestureUndoPushedRef.current = false;
    if (tool !== "erase") eraserHoverRef.current = null;
    redraw();
  }, [tool, redraw]);

  useImperativeHandle(
    ref,
    () => ({
      clear: () => {
        if (strokesRef.current.length > 0) {
          pushUndoSnapshot(cloneStrokes(strokesRef.current));
        }
        strokesRef.current = [];
        currentRef.current = null;
        activeDrawPointerId.current = null;
        activeTouchPanId.current = null;
        touchCoordsRef.current.clear();
        pinchTouchActive.current = false;
        eraserHoverRef.current = null;
        eraseGestureUndoPushedRef.current = false;
        if (remoteSaveTimerRef.current != null) {
          clearTimeout(remoteSaveTimerRef.current);
          remoteSaveTimerRef.current = null;
        }
        try {
          localStorage.setItem(storageKey, JSON.stringify(strokesRef.current));
        } catch {
          // ignore
        }
        const r = remoteInkRef.current;
        if (r) {
          void putInkRemote(r, []).catch(() => {});
        }
        redraw();
        bump((n) => n + 1);
      },
      syncLayout: () => {
        lastAllocRef.current = { cssW: 0, cssH: 0, dpr: 0 };
        resizeToContainer();
        bump((n) => n + 1);
      },
      undo: () => applyUndo(),
      redo: () => applyRedo(),
      canUndo: () => undoStackRef.current.length > 0,
      canRedo: () => redoStackRef.current.length > 0,
    }),
    [persist, redraw, resizeToContainer, putInkRemote, storageKey, pushUndoSnapshot, applyUndo, applyRedo],
  );

  const clientPointFromClient = useCallback((clientX: number, clientY: number): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const surface = canvas.closest("[data-zoom-document-surface]") as HTMLElement | null;
    if (surface) {
      const sr = surface.getBoundingClientRect();
      const sw = Math.max(1, surface.clientWidth);
      const sh = Math.max(1, surface.clientHeight);
      if (sr.width <= 0 || sr.height <= 0) return { x: 0, y: 0 };
      const x = ((clientX - sr.left) / sr.width) * sw;
      const y = ((clientY - sr.top) / sr.height) * sh;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
      return { x, y };
    }
    const rect = canvas.getBoundingClientRect();
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (rect.width <= 0 || rect.height <= 0 || cw <= 0 || ch <= 0) return { x: 0, y: 0 };
    const x = ((clientX - rect.left) / rect.width) * cw;
    const y = ((clientY - rect.top) / rect.height) * ch;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
    return { x, y };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      // DOM/일부 WebView는 빈 문자열을 줄 수 있음. React 타입은 mouse|pen|touch만 포함.
      const pt = e.pointerType as string;
      const bridge = touchPanBridge?.current;

      const beginDrawOrErase = () => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        activeDrawPointerId.current = e.pointerId;

        if (tool === "erase") {
          currentRef.current = null;
          eraseGestureUndoPushedRef.current = false;
          const p = clientPointFromClient(e.clientX, e.clientY);
          eraserHoverRef.current = p;
          const before = cloneStrokes(strokesRef.current);
          const next = eraseStrokesAt(strokesRef.current, p.x, p.y, eraserRadius);
          if (next.length !== strokesRef.current.length) {
            if (!eraseGestureUndoPushedRef.current) {
              pushUndoSnapshot(before);
              eraseGestureUndoPushedRef.current = true;
            }
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
      };

      // 펜·마우스·(빈 타입: 일부 스타일러스/WebView)은 항상 필기.
      if (pt === "pen" || pt === "mouse" || pt === "") {
        if (readInkDebugFlag()) {
          inkDebugLog("pointerDown", {
            decision: "draw-pen-mouse-or-empty-type",
            tool,
            allowFingerInk,
            hasBridge: Boolean(bridge),
            ...inkPointerDiagnostics(e),
          });
        }
        beginDrawOrErase();
        return;
      }

      if (pt === "touch") {
        const stylusAsTouch = isLikelyStylusAsTouch(e);
        if (stylusAsTouch) {
          if (readInkDebugFlag()) {
            inkDebugLog("pointerDown", {
              decision: "draw-touch-as-stylus-heuristic",
              tool,
              allowFingerInk,
              hasBridge: Boolean(bridge),
              ...inkPointerDiagnostics(e),
            });
          }
          beginDrawOrErase();
          return;
        }
        // 손가락 touch — 패닝 또는(옵션) 손가락 필기
        if (!allowFingerInk && bridge) {
          e.preventDefault();
          touchCoordsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

          if (touchCoordsRef.current.size >= 2) {
            if (activeTouchPanId.current !== null) {
              const pid = activeTouchPanId.current;
              bridge.endTouchPan();
              activeTouchPanId.current = null;
              try {
                e.currentTarget.releasePointerCapture(pid);
              } catch {
                // ignore
              }
            }
            const pts = [...touchCoordsRef.current.values()];
            if (pts.length >= 2) {
              const d0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
              if (d0 > 8) {
                pinchTouchActive.current = true;
                bridge.beginPinch?.(d0);
              }
            }
            return;
          }

          e.currentTarget.setPointerCapture(e.pointerId);
          activeTouchPanId.current = e.pointerId;
          bridge.beginTouchPan(e.clientX, e.clientY);
          if (readInkDebugFlag()) {
            inkDebugLog("pointerDown", {
              decision: "touch-begin-pan",
              tool,
              ...inkPointerDiagnostics(e),
            });
          }
          return;
        }
        if (allowFingerInk) {
          if (readInkDebugFlag()) {
            inkDebugLog("pointerDown", {
              decision: "draw-finger-ink-enabled",
              tool,
              ...inkPointerDiagnostics(e),
            });
          }
          beginDrawOrErase();
          return;
        }
        if (readInkDebugFlag()) {
          inkDebugLog("pointerDown", {
            decision: "touch-ignored-no-finger-ink-no-bridge",
            tool,
            hasBridge: Boolean(bridge),
            ...inkPointerDiagnostics(e),
          });
        }
        return;
      }

      if (readInkDebugFlag()) {
        inkDebugLog("pointerDown", {
          decision: "draw-fallback-unknown-pointer-type",
          tool,
          rawPointerType: pt,
          ...inkPointerDiagnostics(e),
        });
      }
      beginDrawOrErase();
    },
    [allowFingerInk, touchPanBridge, tool, strokeColor, strokeWidth, eraserRadius, clientPointFromClient, persist, redraw, pushUndoSnapshot],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const pt = e.pointerType as string;
      const bridge = touchPanBridge?.current;
      const drawingThisPointer = activeDrawPointerId.current === e.pointerId;

      if (readInkDebugFlag()) {
        const now = performance.now();
        if (now >= moveDebugUntilRef.current) {
          moveDebugUntilRef.current = now + 120;
          inkDebugLog("pointerMove", {
            logThrottleMs: 120,
            ...inkPointerDiagnostics(e),
            allowFingerInk,
            hasBridge: Boolean(bridge),
            drawingThisPointer,
            activeTouchPanId: activeTouchPanId.current,
            inTouchMap: touchCoordsRef.current.has(e.pointerId),
            tool,
            branch:
              pt === "touch" && !allowFingerInk && !drawingThisPointer
                ? "touch-pan-or-pinch"
                : !drawingThisPointer
                  ? "ignored-not-active-draw"
                  : tool === "erase"
                    ? "erase-drag"
                    : "draw-extend",
          });
        }
      }

      if (pt === "touch" && !allowFingerInk && !drawingThisPointer) {
        if (touchCoordsRef.current.has(e.pointerId)) {
          touchCoordsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }
        if (pinchTouchActive.current && touchCoordsRef.current.size >= 2 && bridge) {
          const pts = [...touchCoordsRef.current.values()];
          const d1 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          bridge.updatePinch?.(d1);
          return;
        }
        if (
          activeTouchPanId.current === e.pointerId &&
          touchCoordsRef.current.size === 1 &&
          bridge
        ) {
          bridge.moveTouchPan(e.clientX, e.clientY);
        }
        return;
      }

      if (activeDrawPointerId.current !== e.pointerId) return;

      if (tool === "erase") {
        eraserHoverRef.current = clientPointFromClient(e.clientX, e.clientY);
        const list = coalescedClientPoints(e);
        let changed = false;
        for (const ev of list) {
          const p = clientPointFromClient(ev.clientX, ev.clientY);
          const before = cloneStrokes(strokesRef.current);
          const next = eraseStrokesAt(strokesRef.current, p.x, p.y, eraserRadius);
          if (next.length !== strokesRef.current.length) {
            if (!eraseGestureUndoPushedRef.current) {
              pushUndoSnapshot(before);
              eraseGestureUndoPushedRef.current = true;
            }
            strokesRef.current = next;
            changed = true;
          }
        }
        if (changed) persist();
        redraw();
        if (changed) bump((n) => n + 1);
        return;
      }

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
    [allowFingerInk, touchPanBridge, tool, strokeWidth, eraserRadius, clientPointFromClient, persist, redraw, pushUndoSnapshot],
  );

  const endStroke = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const pt = e.pointerType as string;
      const bridge = touchPanBridge?.current;
      const drawingThisPointer = activeDrawPointerId.current === e.pointerId;

      if (pt === "touch" && !allowFingerInk && bridge && !drawingThisPointer) {
        if (readInkDebugFlag()) {
          inkDebugLog("pointerUpOrCancel-touch-pan", {
            ...inkPointerDiagnostics(e),
            phase: "touch-pan-end",
          });
        }
        if (touchCoordsRef.current.has(e.pointerId)) {
          touchCoordsRef.current.delete(e.pointerId);
        }
        if (touchCoordsRef.current.size < 2) {
          if (pinchTouchActive.current) {
            pinchTouchActive.current = false;
            bridge.endPinch?.();
          }
        }
        if (activeTouchPanId.current === e.pointerId) {
          activeTouchPanId.current = null;
          bridge.endTouchPan();
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        }
        return;
      }

      if (activeDrawPointerId.current !== e.pointerId) {
        if (readInkDebugFlag()) {
          const n = performance.now();
          if (n >= ignoredEndLogUntilRef.current) {
            ignoredEndLogUntilRef.current = n + 500;
            inkDebugLog("pointerUpOrCancel", {
              decision: "ignored-not-active-draw-pointer",
              ...inkPointerDiagnostics(e),
              activeDrawPointerId: activeDrawPointerId.current,
            });
          }
        }
        return;
      }
      activeDrawPointerId.current = null;

      if (readInkDebugFlag()) {
        inkDebugLog("pointerUpOrCancel", {
          decision: tool === "erase" ? "erase-stroke-end" : "draw-stroke-commit",
          ...inkPointerDiagnostics(e),
        });
      }

      if (tool === "erase") {
        eraseGestureUndoPushedRef.current = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        redraw();
        return;
      }

      if (currentRef.current && currentRef.current.points.length >= 1) {
        pushUndoSnapshot(cloneStrokes(strokesRef.current));
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
    [allowFingerInk, touchPanBridge, tool, persist, redraw, pushUndoSnapshot],
  );

  const onPointerLeave = useCallback(() => {
    eraserHoverRef.current = null;
    redraw();
  }, [redraw]);

  return (
    <canvas
      ref={canvasRef}
      className={[className, "select-none"].filter(Boolean).join(" ") || undefined}
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerUp={endStroke}
      onPointerCancel={endStroke}
    />
  );
});
