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
import {
  ensureNormalizedStrokes,
  strokeWidthNorm,
  strokeWidthPx,
} from "@/lib/ink/coord-space";

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

function strokeHitByEraser(
  stroke: Stroke,
  px: number,
  py: number,
  eraserR: number,
  contentW: number,
  contentH: number,
): boolean {
  const lineW = strokeWidthPx(stroke.width, contentW);
  const pad = lineW / 2 + eraserR;
  for (const p of stroke.points) {
    const sx = p.x * contentW;
    const sy = p.y * contentH;
    if (Math.hypot(px - sx, py - sy) <= pad) return true;
  }
  for (let i = 1; i < stroke.points.length; i++) {
    const a = stroke.points[i - 1];
    const b = stroke.points[i];
    if (
      pointSegmentDistance(px, py, a.x * contentW, a.y * contentH, b.x * contentW, b.y * contentH) <=
      pad
    ) {
      return true;
    }
  }
  return false;
}

function eraseStrokesAt(
  strokes: Stroke[],
  px: number,
  py: number,
  eraserR: number,
  contentW: number,
  contentH: number,
): Stroke[] {
  return strokes.filter((s) => !strokeHitByEraser(s, px, py, eraserR, contentW, contentH));
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

/** 핀치 종료 후 남은 손가락으로 패닝 재개 */
function resumeTouchPanIfNeeded(
  touchCoords: Map<number, { x: number; y: number }>,
  activeTouchPanId: MutableRefObject<number | null>,
  pinchTouchActive: MutableRefObject<boolean>,
  bridge: ZoomPanTouchBridge | null | undefined,
) {
  if (!bridge || touchCoords.size !== 1) return;
  if (pinchTouchActive.current) {
    pinchTouchActive.current = false;
    bridge.endPinch?.();
  }
  const remainingId = touchCoords.keys().next().value;
  if (remainingId === undefined) return;
  const loc = touchCoords.get(remainingId);
  if (!loc) return;
  activeTouchPanId.current = remainingId;
  bridge.beginTouchPan(loc.x, loc.y);
}

const INK_CONTENT_SELECTOR = "[data-ink-document-content]";

function getInkContentEl(canvas: HTMLCanvasElement | null): HTMLElement | null {
  if (!canvas) return null;
  return canvas.closest(INK_CONTENT_SELECTOR) as HTMLElement | null;
}

function readContentSize(canvas: HTMLCanvasElement | null): { w: number; h: number } {
  const el = getInkContentEl(canvas);
  if (!el) return { w: 1, h: 1 };
  return {
    w: Math.max(1, Math.round(el.clientWidth)),
    h: Math.max(1, Math.round(el.clientHeight)),
  };
}

function applyLoadedStrokes(canvas: HTMLCanvasElement | null, raw: Stroke[]): Stroke[] {
  const { w, h } = readContentSize(canvas);
  return ensureNormalizedStrokes(raw, w, h);
}

function scheduleApplyLoadedStrokes(
  canvas: HTMLCanvasElement | null,
  raw: Stroke[],
  onApplied: (strokes: Stroke[]) => void,
) {
  const attempt = (triesLeft: number) => {
    const { w, h } = readContentSize(canvas);
    if ((w < 32 || h < 32) && triesLeft > 0) {
      requestAnimationFrame(() => attempt(triesLeft - 1));
      return;
    }
    onApplied(applyLoadedStrokes(canvas, raw));
  };
  requestAnimationFrame(() => attempt(8));
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
  /** 필기 move에서 redraw를 프레임당 1회로 묶어 메인 스레드 부담·끊김 완화 */
  const inkRedrawRafRef = useRef<number | null>(null);
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
    const cw = lastAllocRef.current.cssW || readContentSize(canvas).w;
    const ch = lastAllocRef.current.cssH || readContentSize(canvas).h;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokesRef.current) {
      if (s.points.length === 0) continue;
      const lineW = strokeWidthPx(s.width, cw);
      if (s.points.length === 1) {
        const p = s.points[0];
        const r = Math.max(0.6, lineW / 2);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(p.x * cw, p.y * ch, r, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = lineW;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(s.points[0].x * cw, s.points[0].y * ch);
      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(s.points[i].x * cw, s.points[i].y * ch);
      }
      ctx.stroke();
    }
    if (currentRef.current) {
      const s = currentRef.current;
      const lineW = strokeWidthPx(s.width, cw);
      if (s.points.length === 1) {
        const p = s.points[0];
        const r = Math.max(0.6, lineW / 2);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(p.x * cw, p.y * ch, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (s.points.length >= 2) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = lineW;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(s.points[0].x * cw, s.points[0].y * ch);
        for (let i = 1; i < s.points.length; i++) {
          ctx.lineTo(s.points[i].x * cw, s.points[i].y * ch);
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
      ctx.arc(x * cw, y * ch, eraserRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }, [tool, eraserRadius]);

  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;

  const scheduleInkRedraw = useCallback(() => {
    if (inkRedrawRafRef.current != null) return;
    inkRedrawRafRef.current = requestAnimationFrame(() => {
      inkRedrawRafRef.current = null;
      redraw();
    });
  }, [redraw]);

  const flushInkRedraw = useCallback(() => {
    if (inkRedrawRafRef.current != null) {
      cancelAnimationFrame(inkRedrawRafRef.current);
      inkRedrawRafRef.current = null;
    }
    redraw();
  }, [redraw]);

  useEffect(() => {
    return () => {
      if (inkRedrawRafRef.current != null) {
        cancelAnimationFrame(inkRedrawRafRef.current);
        inkRedrawRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const blockSelect = (e: Event) => e.preventDefault();
    el.addEventListener("selectstart", blockSelect);
    return () => el.removeEventListener("selectstart", blockSelect);
  }, []);

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
          if (Array.isArray(parsed)) {
            scheduleApplyLoadedStrokes(canvasRef.current, parsed, (strokes) => {
              if (gen !== inkLoadGenRef.current) return;
              strokesRef.current = strokes;
              bump((n) => n + 1);
              queueMicrotask(() => {
                redrawRef.current();
              });
              notifyInkHistory();
            });
            return;
          }
        }
      } catch {
        strokesRef.current = [];
      }
    };

    if (!remote) {
      applyLocalFallback();
      if (strokesRef.current.length === 0) {
        bump((n) => n + 1);
        queueMicrotask(() => {
          redrawRef.current();
        });
        notifyInkHistory();
      }
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
            scheduleApplyLoadedStrokes(canvasRef.current, arr as Stroke[], (strokes) => {
              if (cancelled || gen !== inkLoadGenRef.current) return;
              strokesRef.current = strokes;
              try {
                localStorage.setItem(storageKey, JSON.stringify(strokesRef.current));
              } catch {
                // ignore
              }
              bump((n) => n + 1);
              queueMicrotask(() => {
                redrawRef.current();
              });
              notifyInkHistory();
            });
            return;
          }
        }
      } catch {
        // fall through
      }
      if (cancelled || gen !== inkLoadGenRef.current) return;
      applyLocalFallback();
      if (strokesRef.current.length === 0) {
        bump((n) => n + 1);
        queueMicrotask(() => {
          redrawRef.current();
        });
        notifyInkHistory();
      }
    })();

    return () => {
      cancelled = true;
      if (remoteSaveTimerRef.current != null) {
        clearTimeout(remoteSaveTimerRef.current);
        remoteSaveTimerRef.current = null;
      }
      void putInkRemote(remote, strokesRef.current).catch(() => {});
    };
  }, [storageKey, remoteInk, putInkRemote, notifyInkHistory]);

  const resizeToContainer = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const surface = getInkContentEl(canvas);
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
    const surface = getInkContentEl(canvasRef.current);
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
        flushInkRedraw();
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
    [persist, redraw, resizeToContainer, putInkRemote, storageKey, pushUndoSnapshot, applyUndo, applyRedo, flushInkRedraw],
  );

  const clientPointFromClient = useCallback((clientX: number, clientY: number): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const content = getInkContentEl(canvas);
    if (content) {
      const sr = content.getBoundingClientRect();
      if (sr.width <= 0 || sr.height <= 0) return { x: 0, y: 0 };
      const x = (clientX - sr.left) / sr.width;
      const y = (clientY - sr.top) / sr.height;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
      return {
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
      };
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
          const { w, h } = readContentSize(canvasRef.current);
          const before = cloneStrokes(strokesRef.current);
          const next = eraseStrokesAt(
            strokesRef.current,
            p.x * w,
            p.y * h,
            eraserRadius,
            w,
            h,
          );
          if (next.length !== strokesRef.current.length) {
            if (!eraseGestureUndoPushedRef.current) {
              pushUndoSnapshot(before);
              eraseGestureUndoPushedRef.current = true;
            }
            strokesRef.current = next;
            bump((n) => n + 1);
          }
          redraw();
          return;
        }

        eraserHoverRef.current = null;
        const { w } = readContentSize(canvasRef.current);
        currentRef.current = {
          color: strokeColor,
          width: strokeWidthNorm(strokeWidth, w),
          points: [clientPointFromClient(e.clientX, e.clientY)],
        };
        flushInkRedraw();
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
    [allowFingerInk, touchPanBridge, tool, strokeColor, strokeWidth, eraserRadius, clientPointFromClient, redraw, pushUndoSnapshot, flushInkRedraw],
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
        if (touchCoordsRef.current.size === 1 && bridge) {
          if (activeTouchPanId.current !== e.pointerId) {
            activeTouchPanId.current = e.pointerId;
            bridge.beginTouchPan(e.clientX, e.clientY);
          } else {
            bridge.moveTouchPan(e.clientX, e.clientY);
          }
        }
        return;
      }

      if (activeDrawPointerId.current !== e.pointerId) return;

      if (tool === "erase") {
        eraserHoverRef.current = clientPointFromClient(e.clientX, e.clientY);
        const { w, h } = readContentSize(canvasRef.current);
        const list = coalescedClientPoints(e);
        let changed = false;
        for (const ev of list) {
          const p = clientPointFromClient(ev.clientX, ev.clientY);
          const before = cloneStrokes(strokesRef.current);
          const next = eraseStrokesAt(
            strokesRef.current,
            p.x * w,
            p.y * h,
            eraserRadius,
            w,
            h,
          );
          if (next.length !== strokesRef.current.length) {
            if (!eraseGestureUndoPushedRef.current) {
              pushUndoSnapshot(before);
              eraseGestureUndoPushedRef.current = true;
            }
            strokesRef.current = next;
            changed = true;
          }
        }
        redraw();
        if (changed) bump((n) => n + 1);
        return;
      }

      if (!currentRef.current) return;

      /** 연속 점 최소 간격(정규화). 크면 샘플이 듬성해져 필기가 끊겨 보임 */
      const { w } = readContentSize(canvasRef.current);
      const minDist = Math.max(0.000012, Math.min(0.0005, strokeWidthNorm(strokeWidth, w) * 0.024));
      const list = coalescedClientPoints(e);
      const pts = currentRef.current.points;
      for (const ev of list) {
        const p = clientPointFromClient(ev.clientX, ev.clientY);
        const last = pts.length > 0 ? pts[pts.length - 1] : null;
        if (last && distance(last, p) < minDist) continue;
        pts.push(p);
      }
      scheduleInkRedraw();
    },
    [
      allowFingerInk,
      touchPanBridge,
      tool,
      strokeWidth,
      eraserRadius,
      clientPointFromClient,
      redraw,
      pushUndoSnapshot,
      scheduleInkRedraw,
    ],
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
        if (touchCoordsRef.current.size < 2 && pinchTouchActive.current) {
          pinchTouchActive.current = false;
          bridge.endPinch?.();
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
        resumeTouchPanIfNeeded(
          touchCoordsRef.current,
          activeTouchPanId,
          pinchTouchActive,
          bridge,
        );
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
        persist();
        redraw();
        return;
      }

      if (currentRef.current && currentRef.current.points.length >= 1) {
        pushUndoSnapshot(cloneStrokes(strokesRef.current));
        strokesRef.current.push(currentRef.current);
        persist();
      }
      currentRef.current = null;
      flushInkRedraw();
      bump((n) => n + 1);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    },
    [allowFingerInk, touchPanBridge, tool, persist, redraw, pushUndoSnapshot, flushInkRedraw],
  );

  const onPointerLeave = useCallback(() => {
    eraserHoverRef.current = null;
    redraw();
  }, [redraw]);

  return (
    <canvas
      ref={canvasRef}
      className={[className, "select-none ainote-no-select"].filter(Boolean).join(" ") || undefined}
      style={{ touchAction: "none" }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerUp={endStroke}
      onPointerCancel={endStroke}
    />
  );
});
