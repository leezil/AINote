"use client";

import dynamic from "next/dynamic";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toJpeg } from "html-to-image";
import type { StoredDocumentMeta } from "@/lib/storage/document-store";
import type { AskRequest } from "@/lib/ai/ask-schema";
import { inferPdfMaterialIntentFromQuestion } from "@/lib/ai/scope-intent";
import { fetchUploadConfig, uploadDocumentFile } from "@/lib/documents/upload-client";
import { useCommittedPdfScale } from "@/lib/pdf/committed-scale";
import { inkDebugLog, readInkDebugFlag } from "@/lib/inkDebug";
import { InkOverlay, type InkOverlayHandle, type ZoomPanTouchBridge } from "@/components/ink/InkOverlay";
import { WorkspaceDocImage } from "@/components/workspace/WorkspaceDocImage";
import { WorkspaceDocText } from "@/components/workspace/WorkspaceDocText";
import { ZoomPanSurface } from "@/components/workspace/ZoomPanSurface";
import { useI18n } from "@/lib/i18n/LocaleProvider";

function PdfViewerLoading() {
  const { t } = useI18n();
  return <p className="p-4 text-sm text-zinc-500">{t("pdfViewer.loading")}</p>;
}

const PdfClientView = dynamic(
  () => import("@/components/pdf/PdfClientView").then((m) => m.PdfClientView),
  { ssr: false, loading: PdfViewerLoading },
);

const defaultWorkspaceId =
  process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_ID?.trim() || "local";

const FULLSCREEN_AI_WIDTH_KEY = "ainote:fullscreenAiWidth";
const AI_LAYOUT_STORAGE_KEY = "ainote:aiLayoutV2";

type PdfAskMode =
  | "auto_material"
  | "force_current_page"
  | "force_full_document"
  | "current_page_plus_capture"
  | "capture_only";

type PenTool = "ink" | "erase";
type AiPanelSide = "left" | "right";
type AiLandscapeStack = "bottom" | "top";

export function WorkspaceApp() {
  const { t, translateError } = useI18n();
  const [documents, setDocuments] = useState<StoredDocumentMeta[]>([]);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pageByDoc, setPageByDoc] = useState<Record<string, number>>({});
  /** react-pdf가 알려준 실제 페이지 수(문서 id별). 서버 pageCount가 1로만 올 때 보정. */
  const [pdfNumPagesByDoc, setPdfNumPagesByDoc] = useState<Record<string, number>>({});
  const captureRef = useRef<HTMLDivElement | null>(null);
  const inkRef = useRef<InkOverlayHandle | null>(null);
  const [inkHistoryEpoch, setInkHistoryEpoch] = useState(0);

  const [question, setQuestion] = useState("");
  const [pdfAskMode, setPdfAskMode] = useState<PdfAskMode>("auto_material");
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 문서 뷰어 전체화면 + md */
  const [viewerFullscreen, setViewerFullscreen] = useState(false);
  /** true: 필기 / false: 이동·확대(손가락은 Ink→touchBridge로 패닝) */
  const [gestureInk, setGestureInk] = useState(true);
  const [penTool, setPenTool] = useState<PenTool>("ink");
  const [allowFingerInk, setAllowFingerInk] = useState(false);
  /** 세로 뷰포트(상하 스택): AI를 아래(기본) 또는 위 */
  const [aiLandscapeStack, setAiLandscapeStack] = useState<AiLandscapeStack>("bottom");
  /** 가로 뷰포트(좌우 분할): AI를 오른쪽(기본) 또는 왼쪽 */
  const [aiPanelSide, setAiPanelSide] = useState<AiPanelSide>("right");
  const [layoutViewport, setLayoutViewport] = useState({ w: 0, h: 0 });
  /** 전체화면에서 AI 패널 표시 */
  const [fullscreenAiOpen, setFullscreenAiOpen] = useState(true);
  const [aiPanelWidthPx, setAiPanelWidthPx] = useState(380);
  const [isMdUp, setIsMdUp] = useState(false);
  const {
    zoomScale,
    committedScale,
    onGestureScaleChange,
    onGestureScaleSettled,
  } = useCommittedPdfScale(1);
  const [inkColor, setInkColor] = useState("#2563eb");
  const [inkWidth, setInkWidth] = useState(2.8);
  const [eraserRadius, setEraserRadius] = useState(18);
  const touchPanBridgeRef = useRef<ZoomPanTouchBridge | null>(null);

  const inkLayerActive = Boolean(activeId);
  const inkPointerActive = inkLayerActive && gestureInk;
  const viewportPdfScale = zoomScale;

  useEffect(() => {
    if (!readInkDebugFlag()) return;
    inkDebugLog("workspace-ink-state", {
      activeId,
      inkLayerActive,
      gestureInk,
      inkPointerActive,
      allowFingerInk,
      penTool,
      hint: inkPointerActive
        ? "InkOverlay: pointer-events-auto (이벤트 도달 가능)"
        : !inkLayerActive
          ? "문서 미선택 → 잉크 레이어 비활성"
          : !gestureInk
            ? "이동·확대 모드 → 잉크 캔버스 pointer-events-none"
            : "상태 확인 필요",
    });
  }, [activeId, inkLayerActive, gestureInk, inkPointerActive, allowFingerInk, penTool]);

  /** 콘솔에서 `__AINOTE_INK_DEBUG__`만 켠 경우에도 안내(로그는 pointer 이벤트 때만 쌓임) */
  useEffect(() => {
    let prev = readInkDebugFlag();
    const id = window.setInterval(() => {
      const now = readInkDebugFlag();
      if (now && !prev) {
        console.info(
          "[ainote:ink] 디버그 켜짐 — 문서 선택·「필기」모드 확인 후 PDF 위에서 그려 보세요. 상세는 [ainote:ink] 로그(Info). Chrome이면 콘솔 상단 필터에서 Default / Info 포함인지 확인하세요.",
        );
      }
      prev = now;
    }, 400);
    return () => clearInterval(id);
  }, []);
  const isMdFsViewport =
    viewerFullscreen && isMdUp && layoutViewport.w > 0;
  /** 세로로 긴 뷰포트(세로 모드): 뷰어·AI 상하 스택 → AI 상단/하단 */
  const aiLayoutVerticalStack =
    isMdFsViewport && layoutViewport.w <= layoutViewport.h;
  /** 가로로 넓은 뷰포트(가로 모드): 뷰어·AI 좌우 분할 → AI 왼쪽/오른쪽 */
  const aiLayoutHorizontalSplit =
    isMdFsViewport && layoutViewport.w > layoutViewport.h;
  const fsOrderSwap =
    (viewerFullscreen && isMdUp && aiLayoutVerticalStack && aiLandscapeStack === "top") ||
    (viewerFullscreen && isMdUp && aiLayoutHorizontalSplit && aiPanelSide === "left");


  const aiPanelWidthRef = useRef(aiPanelWidthPx);
  const aiDividerDraggingRef = useRef(false);
  const aiResizeRafRef = useRef<number | null>(null);
  const aiResizePendingSpanRef = useRef<number | null>(null);
  if (!aiDividerDraggingRef.current) {
    aiPanelWidthRef.current = aiPanelWidthPx;
  }
  const aiPanelSideRef = useRef(aiPanelSide);
  aiPanelSideRef.current = aiPanelSide;
  const aiLandscapeStackRef = useRef(aiLandscapeStack);
  aiLandscapeStackRef.current = aiLandscapeStack;
  const aiResizeModeRef = useRef<"row" | "colBottom" | "colTop">("row");
  const aiResizeDragRef = useRef<{ startClient: number; startSpan: number } | null>(null);
  const aiResizeListenersRef = useRef<{
    move: (ev: PointerEvent) => void;
    up: (ev: PointerEvent) => void;
  } | null>(null);

  const clampAiSpanRow = useCallback((w: number) => {
    const maxW = Math.min(Math.floor(window.innerWidth * 0.58), 720);
    return Math.min(maxW, Math.max(260, w));
  }, []);

  const clampAiSpanCol = useCallback((h: number) => {
    return Math.min(Math.floor(window.innerHeight * 0.72), Math.max(160, h));
  }, []);

  const saveAiLayoutToStorage = useCallback(
    (spanOverride?: number, o?: { side?: AiPanelSide; stack?: AiLandscapeStack }) => {
      const span = spanOverride ?? aiPanelWidthRef.current;
      const side = o?.side ?? aiPanelSideRef.current;
      const stack = o?.stack ?? aiLandscapeStackRef.current;
      try {
        sessionStorage.setItem(
          AI_LAYOUT_STORAGE_KEY,
          JSON.stringify({
            span,
            side,
            stack,
          }),
        );
      } catch {
        // ignore
      }
    },
    [],
  );

  const detachAiResizeListeners = useCallback(() => {
    const L = aiResizeListenersRef.current;
    if (!L) return;
    window.removeEventListener("pointermove", L.move);
    window.removeEventListener("pointerup", L.up);
    window.removeEventListener("pointercancel", L.up);
    aiResizeListenersRef.current = null;
    aiResizeDragRef.current = null;
    aiDividerDraggingRef.current = false;
    if (aiResizeRafRef.current != null) {
      cancelAnimationFrame(aiResizeRafRef.current);
      aiResizeRafRef.current = null;
    }
  }, []);

  const onAiDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (aiResizeListenersRef.current) return;

      aiDividerDraggingRef.current = true;

      const w = window.innerWidth;
      const h = window.innerHeight;
      const horizSplit = viewerFullscreen && isMdUp && w > h;
      if (horizSplit) {
        aiResizeModeRef.current = "row";
        aiResizeDragRef.current = {
          startClient: e.clientX,
          startSpan: aiPanelWidthRef.current,
        };
      } else {
        aiResizeModeRef.current =
          aiLandscapeStackRef.current === "bottom" ? "colBottom" : "colTop";
        aiResizeDragRef.current = {
          startClient: e.clientY,
          startSpan: aiPanelWidthRef.current,
        };
      }

      const move = (ev: PointerEvent) => {
        const s = aiResizeDragRef.current;
        if (!s) return;
        ev.preventDefault();
        const mode = aiResizeModeRef.current;
        let next: number;
        if (mode === "row") {
          const dx = ev.clientX - s.startClient;
          const dRow = aiPanelSideRef.current === "left" ? dx : -dx;
          next = clampAiSpanRow(s.startSpan + dRow);
        } else if (mode === "colBottom") {
          next = clampAiSpanCol(s.startSpan + (ev.clientY - s.startClient));
        } else {
          next = clampAiSpanCol(s.startSpan - (ev.clientY - s.startClient));
        }
        aiResizePendingSpanRef.current = next;
        aiPanelWidthRef.current = next;
        if (aiResizeRafRef.current == null) {
          aiResizeRafRef.current = requestAnimationFrame(() => {
            aiResizeRafRef.current = null;
            const v = aiResizePendingSpanRef.current;
            if (v != null) setAiPanelWidthPx(v);
          });
        }
      };

      const upWrapped = (ev: PointerEvent) => {
        if (aiResizeRafRef.current != null) {
          cancelAnimationFrame(aiResizeRafRef.current);
          aiResizeRafRef.current = null;
        }
        const s = aiResizeDragRef.current;
        const mode = aiResizeModeRef.current;
        let next = aiPanelWidthRef.current;
        if (s) {
          if (mode === "row") {
            const dx = ev.clientX - s.startClient;
            const dRow = aiPanelSideRef.current === "left" ? dx : -dx;
            next = clampAiSpanRow(s.startSpan + dRow);
          } else if (mode === "colBottom") {
            next = clampAiSpanCol(s.startSpan + (ev.clientY - s.startClient));
          } else {
            next = clampAiSpanCol(s.startSpan - (ev.clientY - s.startClient));
          }
          setAiPanelWidthPx(next);
        }
        detachAiResizeListeners();
        saveAiLayoutToStorage(next);
        requestAnimationFrame(() => {
          inkRef.current?.syncLayout();
        });
      };

      aiResizeListenersRef.current = { move, up: upWrapped };
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", upWrapped);
      window.addEventListener("pointercancel", upWrapped);
    },
    [
      viewerFullscreen,
      isMdUp,
      clampAiSpanRow,
      clampAiSpanCol,
      detachAiResizeListeners,
      saveAiLayoutToStorage,
    ],
  );

  useEffect(() => {
    return () => {
      detachAiResizeListeners();
    };
  }, [detachAiResizeListeners]);

  useEffect(() => {
    if (!gestureInk) return;
    const id = requestAnimationFrame(() => {
      inkRef.current?.syncLayout();
    });
    return () => cancelAnimationFrame(id);
  }, [gestureInk]);

  const workspaceHeaders = useMemo(
    () => ({ "x-workspace-id": defaultWorkspaceId }),
    [],
  );

  const refreshDocuments = useCallback(async () => {
    const res = await fetch("/api/documents", { headers: workspaceHeaders });
    if (!res.ok) return;
    const data = (await res.json()) as { documents: StoredDocumentMeta[] };
    setDocuments(data.documents ?? []);
  }, [workspaceHeaders]);

  useEffect(() => {
    startTransition(() => {
      void refreshDocuments();
    });
  }, [refreshDocuments]);

  useEffect(() => {
    if (!viewerFullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewerFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [viewerFullscreen]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(AI_LAYOUT_STORAGE_KEY);
      if (raw) {
        const o = JSON.parse(raw) as { span?: number; side?: string; stack?: string };
        if (typeof o.span === "number" && o.span >= 160 && o.span <= 1200) setAiPanelWidthPx(o.span);
        if (o.side === "left" || o.side === "right") setAiPanelSide(o.side);
        if (o.stack === "top" || o.stack === "bottom") setAiLandscapeStack(o.stack);
        return;
      }
      const legacy = sessionStorage.getItem(FULLSCREEN_AI_WIDTH_KEY);
      if (legacy) {
        const n = Number.parseInt(legacy, 10);
        if (Number.isFinite(n) && n >= 260 && n <= 1200) setAiPanelWidthPx(n);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const sync = () => setLayoutViewport({ w: window.innerWidth, h: window.innerHeight });
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsMdUp(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const activeMeta = useMemo(
    () => documents.find((d) => d.id === activeId) ?? null,
    [documents, activeId],
  );

  const pdfPageTotal =
    activeMeta?.kind === "pdf" && activeMeta.id
      ? pdfNumPagesByDoc[activeMeta.id] ?? activeMeta.pageCount
      : activeMeta?.pageCount ?? 1;

  const currentPage = activeId ? pageByDoc[activeId] ?? 1 : 1;

  /** 전체화면·AI 패널·뷰포트 변경 후 필기 캔버스를 문서 크기에 다시 맞춤 */
  useEffect(() => {
    if (!activeId) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        inkRef.current?.syncLayout();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [
    activeId,
    viewerFullscreen,
    fullscreenAiOpen,
    aiPanelWidthPx,
    aiPanelSide,
    aiLandscapeStack,
    isMdUp,
    layoutViewport.w,
    layoutViewport.h,
    currentPage,
  ]);

  const setPage = (p: number) => {
    if (!activeId) return;
    setPageByDoc((prev) => ({ ...prev, [activeId]: p }));
  };

  const openDocument = useCallback(
    (id: string, hint?: Pick<StoredDocumentMeta, "kind">) => {
      const kind = hint?.kind ?? documents.find((d) => d.id === id)?.kind;
      setOpenTabs((tabs) => (tabs.includes(id) ? tabs : [...tabs, id]));
      setActiveId(id);
      setPageByDoc((prev) => ({ ...prev, [id]: prev[id] ?? 1 }));
      if (kind === "image") setPdfAskMode("auto_material");
      else if (kind === "text") setPdfAskMode("auto_material");
      else setPdfAskMode("auto_material");
    },
    [documents],
  );

  const uploadConfigRef = useRef<Awaited<ReturnType<typeof fetchUploadConfig>> | null>(null);

  useEffect(() => {
    void fetchUploadConfig().then((cfg) => {
      uploadConfigRef.current = cfg;
    });
  }, []);

  const onUpload: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const config = uploadConfigRef.current ?? (await fetchUploadConfig());
      uploadConfigRef.current = config;
      const doc = await uploadDocumentFile(
        file,
        defaultWorkspaceId,
        workspaceHeaders,
        config,
      );
      await refreshDocuments();
      openDocument(doc.id, { kind: doc.kind });
    } catch (err) {
      setError(
        translateError(err instanceof Error ? err.message : t("workspace.errUploadFailed")),
      );
    }
  };

  const selectTab = useCallback(
    (id: string) => {
      setActiveId(id);
      const meta = documents.find((d) => d.id === id);
      if (meta?.kind === "image") setPdfAskMode("auto_material");
      else if (meta?.kind === "text") setPdfAskMode("auto_material");
      else setPdfAskMode("auto_material");
    },
    [documents],
  );

  const captureViewportJpeg = async (): Promise<string> => {
    const node = captureRef.current;
    if (!node) throw new Error(t("workspace.errCaptureNotReady"));
    return await toJpeg(node, {
      quality: 0.84,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.6),
      cacheBust: true,
    });
  };

  const submitQuestion = async () => {
    setError(null);
    setAnswer(null);
    const q = question.trim();
    if (!q) {
      setError(t("workspace.errEnterQuestion"));
      return;
    }
    if (!activeMeta) {
      setError(t("workspace.errSelectDoc"));
      return;
    }

    setBusy(true);
    try {
      let body: AskRequest;

      if (activeMeta.kind === "pdf") {
        if (pdfAskMode === "capture_only") {
          const dataUrl = await captureViewportJpeg();
          body = {
            question: q,
            scope: {
              kind: "viewport_only",
              viewportImageBase64: dataUrl,
              viewportMimeType: "image/jpeg",
            },
          };
        } else if (pdfAskMode === "current_page_plus_capture") {
          const dataUrl = await captureViewportJpeg();
          body = {
            question: q,
            scope: {
              kind: "pdf_page_text_plus_viewport",
              documentId: activeMeta.id,
              page: currentPage,
              viewportImageBase64: dataUrl,
              viewportMimeType: "image/jpeg",
            },
          };
        } else {
          const useFull =
            pdfAskMode === "force_full_document" ||
            (pdfAskMode === "auto_material" &&
              inferPdfMaterialIntentFromQuestion(q) === "full_document");

          if (useFull) {
            body = {
              question: q,
              scope: {
                kind: "pdf_full_text",
                documentId: activeMeta.id,
                pageCountHint: pdfPageTotal >= 1 ? pdfPageTotal : undefined,
              },
            };
          } else {
            body = {
              question: q,
              scope: {
                kind: "pdf_page_text",
                documentId: activeMeta.id,
                page: currentPage,
              },
            };
          }
        }
      } else if (activeMeta.kind === "image") {
        body = {
          question: q,
          scope: { kind: "image_file", documentId: activeMeta.id },
        };
      } else {
        body = {
          question: q,
          scope: { kind: "text_file", documentId: activeMeta.id },
        };
      }

      const res = await fetch("/api/ai/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...workspaceHeaders },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          translateError(
            typeof payload.error === "string" ? payload.error : t("workspace.errAiFailed"),
          ),
        );
        return;
      }
      setAnswer(typeof payload.answer === "string" ? payload.answer : "");
    } catch (err) {
      setError(
        translateError(err instanceof Error ? err.message : t("workspace.errGeneric")),
      );
    } finally {
      setBusy(false);
    }
  };

  const fileUrl = activeMeta
    ? `/api/documents/${activeMeta.id}/file`
    : "";

  const inkStorageKey = useMemo(() => {
    if (!activeMeta) return "ainote:ink:none";
    if (activeMeta.kind === "pdf") {
      return `ainote:ink:${defaultWorkspaceId}:${activeMeta.id}:p${currentPage}`;
    }
    return `ainote:ink:${defaultWorkspaceId}:${activeMeta.id}`;
  }, [activeMeta, currentPage, defaultWorkspaceId]);

  const inkRemote = useMemo(() => {
    if (!activeMeta) return null;
    return {
      documentId: activeMeta.id,
      page: activeMeta.kind === "pdf" ? currentPage : null,
      headers: workspaceHeaders,
    };
  }, [activeMeta, currentPage, workspaceHeaders]);

  const bumpInkHistory = useCallback(() => setInkHistoryEpoch((n) => n + 1), []);

  void inkHistoryEpoch;
  const canInkUndo = inkRef.current?.canUndo?.() ?? false;
  const canInkRedo = inkRef.current?.canRedo?.() ?? false;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeId || !gestureInk || !inkLayerActive) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('textarea, input, select, [contenteditable="true"]')) return;

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === "z" || e.key === "Z") {
        if (e.shiftKey) {
          if (inkRef.current?.redo?.()) e.preventDefault();
        } else if (inkRef.current?.undo?.()) {
          e.preventDefault();
        }
      } else if (e.key === "y" || e.key === "Y") {
        if (inkRef.current?.redo?.()) e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, gestureInk, inkLayerActive]);

  /** 필기 모드에서 빠른 연속 획 후 텍스트(사이드바·헤더 등)로 선택이 넘어가는 것 방지 */
  useEffect(() => {
    if (!inkPointerActive) return;
    const block = (e: Event) => {
      e.preventDefault();
    };
    document.addEventListener("selectstart", block, true);
    document.addEventListener("dragstart", block, true);
    return () => {
      document.removeEventListener("selectstart", block, true);
      document.removeEventListener("dragstart", block, true);
    };
  }, [inkPointerActive]);

  return (
    <div
      className={[
        "mx-auto flex min-h-0 w-full flex-1",
        inkPointerActive ? "select-none ainote-no-select" : "",
        viewerFullscreen
          ? "max-w-none flex-col p-0"
          : "max-w-6xl flex-col gap-3 p-3 md:flex-row md:gap-4 md:p-4",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <aside
        className={[
          viewerFullscreen ? "hidden" : "flex",
          "w-full shrink-0 flex-col gap-2 md:w-56",
        ].join(" ")}
      >
        <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs font-medium text-zinc-500">{t("workspace.materials")}</p>
          <label className="mt-2 flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-2 py-3 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800">
            <input type="file" className="hidden" accept=".pdf,image/*,.txt" onChange={onUpload} />
            {t("workspace.upload")}
          </label>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="px-2 pb-1 text-xs font-medium text-zinc-500">{t("workspace.savedDocs")}</p>
          <ul className="max-h-40 space-y-1 overflow-auto text-sm">
            {documents.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  className="w-full truncate rounded-lg px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900"
                  onClick={() => openDocument(d.id, { kind: d.kind })}
                >
                  {d.filename}
                </button>
              </li>
            ))}
            {documents.length === 0 ? (
              <li className="px-2 py-2 text-zinc-500">{t("workspace.none")}</li>
            ) : null}
          </ul>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="px-2 pb-1 text-xs font-medium text-zinc-500">{t("workspace.openTabs")}</p>
          <ul className="max-h-48 space-y-1 overflow-auto md:max-h-[28rem]">
            {openTabs.map((id) => {
              const meta = documents.find((d) => d.id === id);
              if (!meta) return null;
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => selectTab(id)}
                    className={`w-full truncate rounded-lg px-2 py-2 text-left text-sm ${
                      id === activeId
                        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                        : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
                    }`}
                  >
                    {meta.filename}
                  </button>
                </li>
              );
            })}
            {openTabs.length === 0 ? (
              <li className="px-2 py-2 text-sm text-zinc-500">{t("workspace.uploadFirst")}</li>
            ) : null}
          </ul>
        </div>
      </aside>

      <main
        className={[
          "flex min-h-0 min-w-0 flex-1",
          viewerFullscreen
            ? [
                "fixed inset-0 z-50 m-0 h-[100dvh] max-w-none overflow-hidden flex-col bg-white p-0 dark:bg-zinc-950",
                isMdUp && aiLayoutHorizontalSplit ? "md:flex-row md:gap-0" : "",
              ].join(" ")
            : "flex-col gap-3",
        ].join(" ")}
      >
        <section
          className={[
            "flex min-h-0 min-w-0 flex-col overflow-hidden border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950",
            viewerFullscreen
              ? [
                  "min-h-0 flex-1 rounded-none border-0 shadow-none md:min-h-0",
                  viewerFullscreen && fullscreenAiOpen
                    ? fsOrderSwap
                      ? "order-3"
                      : "order-1"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")
              : "flex-1 rounded-xl",
          ].join(" ")}
        >
          <header className="relative z-30 flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-100 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
            {activeMeta?.kind === "pdf" ? (
              <>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
                  onClick={() => setPage(Math.max(1, currentPage - 1))}
                >
                  {t("workspace.prev")}
                </button>
                <span className="text-sm text-zinc-600 dark:text-zinc-300">
                  {currentPage} / {pdfPageTotal}
                </span>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
                  onClick={() =>
                    setPage(Math.min(pdfPageTotal, currentPage + 1))
                  }
                >
                  {t("workspace.next")}
                </button>
              </>
            ) : (
              <span className="text-sm text-zinc-600 dark:text-zinc-300">
                {activeMeta?.filename ?? t("workspace.noDocument")}
              </span>
            )}
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className={[
                  "rounded-md border px-2 py-1 text-sm",
                  !gestureInk
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-200 dark:border-zinc-700",
                ].join(" ")}
                onClick={() => setGestureInk(false)}
              >
                {t("workspace.modeNav")}
              </button>
              <button
                type="button"
                className={[
                  "rounded-md border px-2 py-1 text-sm",
                  gestureInk
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-200 dark:border-zinc-700",
                ].join(" ")}
                onClick={() => setGestureInk(true)}
              >
                {t("workspace.modeInk")}
              </button>
              <button
                type="button"
                className={[
                  "rounded-md border px-2 py-1 text-sm",
                  penTool === "ink"
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-200 dark:border-zinc-700",
                ].join(" ")}
                onClick={() => setPenTool("ink")}
              >
                {t("workspace.ink")}
              </button>
              <button
                type="button"
                className={[
                  "rounded-md border px-2 py-1 text-sm",
                  penTool === "erase"
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-200 dark:border-zinc-700",
                ].join(" ")}
                onClick={() => setPenTool("erase")}
              >
                {t("workspace.erase")}
              </button>
              {inkLayerActive ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                    {t("workspace.color")}
                    <input
                      type="color"
                      value={inkColor}
                      onChange={(e) => setInkColor(e.target.value)}
                      className="h-7 w-8 cursor-pointer rounded border border-zinc-300 bg-white p-0 dark:border-zinc-600"
                      title={t("workspace.penColorTitle")}
                    />
                  </label>
                  <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                    {t("workspace.width")}
                    <input
                      type="range"
                      min={1}
                      max={12}
                      step={0.5}
                      value={inkWidth}
                      onChange={(e) => setInkWidth(Number(e.target.value))}
                      className="w-20"
                      title={t("workspace.penWidthTitle")}
                    />
                  </label>
                  {penTool === "erase" ? (
                    <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                      {t("workspace.erase")}
                      <input
                        type="range"
                        min={4}
                        max={48}
                        step={1}
                        value={eraserRadius}
                        onChange={(e) => setEraserRadius(Number(e.target.value))}
                        className="w-20"
                        title={t("workspace.eraserSizeTitle")}
                      />
                    </label>
                  ) : null}
                </span>
              ) : null}
              {inkLayerActive ? (
                <>
                  <button
                    type="button"
                    className="rounded-md border border-zinc-200 px-2 py-1 text-sm disabled:opacity-40 dark:border-zinc-700"
                    disabled={!canInkUndo}
                    onClick={() => inkRef.current?.undo()}
                    title={t("workspace.inkUndo")}
                  >
                    {t("workspace.inkUndo")}
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-zinc-200 px-2 py-1 text-sm disabled:opacity-40 dark:border-zinc-700"
                    disabled={!canInkRedo}
                    onClick={() => inkRef.current?.redo()}
                    title={t("workspace.inkRedo")}
                  >
                    {t("workspace.inkRedo")}
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="rounded-md border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
                onClick={() => inkRef.current?.clear()}
              >
                {t("workspace.clearAllInk")}
              </button>
              {gestureInk ? (
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                  <input
                    type="checkbox"
                    className="rounded border-zinc-300 dark:border-zinc-600"
                    checked={allowFingerInk}
                    onChange={(e) => setAllowFingerInk(e.target.checked)}
                  />
                  {t("workspace.fingerInk")}
                </label>
              ) : null}
              {viewerFullscreen ? (
                fullscreenAiOpen ? (
                  <button
                    type="button"
                    className="rounded-md border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
                    onClick={() => setFullscreenAiOpen(false)}
                  >
                    {t("workspace.aiHide")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="rounded-md border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
                    onClick={() => setFullscreenAiOpen(true)}
                  >
                    {t("workspace.aiShow")}
                  </button>
                )
              ) : null}
              <button
                type="button"
                className="rounded-md border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
                onClick={() => setViewerFullscreen((v) => !v)}
              >
                {viewerFullscreen ? t("workspace.fullscreenExit") : t("workspace.fullscreenEnter")}
              </button>
            </div>
          </header>

          <div
            className={[
              "relative isolate z-0 bg-zinc-50 dark:bg-zinc-900/40",
              viewerFullscreen ? "min-h-0 flex-1 touch-none overflow-hidden" : "min-h-[320px] flex-1 overflow-auto",
            ].join(" ")}
          >
            {!activeMeta ? (
              <p className="p-6 text-sm text-zinc-500">{t("workspace.pickDocHint")}</p>
            ) : (
              <ZoomPanSurface
                navigationMode={!gestureInk}
                className={viewerFullscreen ? "h-full min-h-0" : "min-h-[320px]"}
                initialScale={zoomScale}
                rasterCommitScale={committedScale}
                onScaleChange={onGestureScaleChange}
                onScaleSettled={onGestureScaleSettled}
                touchBridgeRef={touchPanBridgeRef}
                stretchContent={viewerFullscreen && inkLayerActive}
                viewResetKey={
                  activeMeta ? `${activeMeta.id}-${currentPage}` : "none"
                }
                panResetKey={
                  activeMeta
                    ? activeMeta.kind === "pdf"
                      ? `${activeMeta.id}-p${currentPage}`
                      : activeMeta.id
                    : "none"
                }
              >
                <div
                  ref={captureRef}
                  data-zoom-document-surface
                  className={[
                    "relative isolate mx-auto max-w-full",
                    activeMeta.kind === "pdf" ? "ainote-no-select" : "",
                    viewerFullscreen
                      ? "flex min-h-0 w-max max-w-full max-h-full flex-col items-center"
                      : "w-max",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <div
                    className={[
                      viewerFullscreen && inkLayerActive
                        ? "max-h-full min-h-0 touch-none overflow-hidden"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <div
                      data-ink-document-content
                      className="relative inline-block max-w-full align-top"
                    >
                      {activeMeta.kind === "pdf" ? (
                        <div
                          className={
                            inkPointerActive
                              ? "pointer-events-none [&_*]:pointer-events-none"
                              : undefined
                          }
                        >
                          <PdfClientView
                            key={activeMeta.id}
                            fileUrl={fileUrl}
                            pageNumber={currentPage}
                            maxWidthPx={8192}
                            wideMode={viewerFullscreen}
                            viewportScale={viewportPdfScale}
                            committedScale={committedScale}
                            onPdfLoaded={(n) => {
                              setPdfNumPagesByDoc((prev) => ({
                                ...prev,
                                [activeMeta.id]: n,
                              }));
                              setPageByDoc((prev) => {
                                const cur = prev[activeMeta.id] ?? 1;
                                if (cur <= n) return prev;
                                return { ...prev, [activeMeta.id]: n };
                              });
                            }}
                          />
                        </div>
                      ) : activeMeta.kind === "image" ? (
                        <div
                          className={
                            inkPointerActive
                              ? "pointer-events-none [&_*]:pointer-events-none"
                              : undefined
                          }
                        >
                          <WorkspaceDocImage
                            key={activeMeta.id}
                            fileUrl={fileUrl}
                            fetchHeaders={workspaceHeaders}
                            alt={activeMeta.filename}
                            maxWidthPx={8192}
                            wideMode={viewerFullscreen}
                            viewportScale={viewportPdfScale}
                            committedScale={committedScale}
                            remeasureKey={activeMeta.id}
                          />
                        </div>
                      ) : (
                        <div
                          className={
                            inkPointerActive
                              ? "pointer-events-none [&_*]:pointer-events-none"
                              : undefined
                          }
                        >
                          <WorkspaceDocText
                            key={activeMeta.id}
                            fileUrl={fileUrl}
                            fetchHeaders={workspaceHeaders}
                            maxWidthPx={8192}
                            wideMode={viewerFullscreen}
                            viewportScale={viewportPdfScale}
                            committedScale={committedScale}
                            remeasureKey={activeMeta.id}
                          />
                        </div>
                      )}
                      <InkOverlay
                        key={inkStorageKey}
                        ref={inkRef}
                        storageKey={inkStorageKey}
                        remoteInk={inkRemote}
                        onInkHistoryChange={bumpInkHistory}
                        allowFingerInk={allowFingerInk}
                        touchPanBridge={touchPanBridgeRef}
                        tool={penTool === "erase" ? "erase" : "draw"}
                        strokeColor={inkColor}
                        strokeWidth={inkWidth}
                        eraserRadius={eraserRadius}
                        viewportScale={viewportPdfScale}
                        className={[
                          "absolute inset-0 z-[50]",
                          inkPointerActive ? "pointer-events-auto" : "pointer-events-none",
                        ].join(" ")}
                      />
                    </div>
                  </div>
                </div>
              </ZoomPanSurface>
            )}
          </div>
        </section>

        {viewerFullscreen && fullscreenAiOpen && isMdUp ? (
          <div
            role="separator"
            aria-label={aiLayoutVerticalStack ? t("workspace.resizeAiHeight") : t("workspace.resizeAiWidth")}
            aria-orientation={aiLayoutVerticalStack ? "horizontal" : "vertical"}
            className={[
              "relative z-20 shrink-0 touch-none select-none bg-zinc-200 hover:bg-zinc-400 dark:bg-zinc-700 dark:hover:bg-zinc-500",
              "order-2 hidden md:block",
              aiLayoutVerticalStack
                ? "h-3 w-full cursor-row-resize"
                : "w-3 cursor-col-resize self-stretch",
            ].join(" ")}
            onPointerDown={onAiDividerPointerDown}
          />
        ) : null}

        {(!viewerFullscreen || fullscreenAiOpen) ? (
        <section
          className={[
            "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950",
            viewerFullscreen
              ? [
                  "flex min-h-0 shrink-0 flex-col overflow-y-auto",
                  viewerFullscreen && fullscreenAiOpen
                    ? fsOrderSwap
                      ? "order-1"
                      : "order-3"
                    : "",
                  isMdUp && aiLayoutVerticalStack
                    ? [
                        "w-full p-3 md:p-4",
                        aiLandscapeStack === "top"
                          ? "border-b border-zinc-200 dark:border-zinc-800"
                          : "border-t border-zinc-200 dark:border-zinc-800",
                      ].join(" ")
                    : isMdUp
                      ? [
                          "max-h-[42vh] border-t border-zinc-200 dark:border-zinc-800 md:max-h-none md:border-t-0 md:p-4",
                          aiPanelSide === "right"
                            ? "md:border-l md:border-zinc-200 md:dark:border-zinc-800"
                            : "md:border-r md:border-zinc-200 md:dark:border-zinc-800",
                        ].join(" ")
                      : "max-h-[42vh] min-h-0 shrink-0 border-t border-zinc-200 p-3 dark:border-zinc-800",
                ]
                  .filter(Boolean)
                  .join(" ")
              : "rounded-xl border p-3 shadow-sm",
          ].join(" ")}
          style={
            viewerFullscreen && fullscreenAiOpen && isMdUp
              ? aiLayoutVerticalStack
                ? {
                    height: aiPanelWidthPx,
                    minHeight: 160,
                    maxHeight: "min(72vh, 900px)",
                  }
                : {
                    width: aiPanelWidthPx,
                    minWidth: 260,
                    maxWidth: "min(58vw, 720px)",
                  }
              : undefined
          }
        >
          <div className="mb-2 flex min-w-0 flex-wrap items-start justify-between gap-2 md:mb-3">
            <p className="min-w-0 flex-1 text-sm font-medium text-zinc-800 dark:text-zinc-100">
              {t("workspace.aiAskTitle")}
            </p>
            {viewerFullscreen && isMdUp ? (
              <div className="flex shrink-0 flex-wrap justify-end gap-1">
                {aiLayoutVerticalStack ? (
                  <>
                    <button
                      type="button"
                      className={[
                        "rounded-md border px-2 py-1 text-xs",
                        aiLandscapeStack === "bottom"
                          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                          : "border-zinc-200 dark:border-zinc-700",
                      ].join(" ")}
                      onClick={() => {
                        setAiLandscapeStack("bottom");
                        saveAiLayoutToStorage(undefined, { stack: "bottom" });
                      }}
                    >
                      {t("workspace.aiBottom")}
                    </button>
                    <button
                      type="button"
                      className={[
                        "rounded-md border px-2 py-1 text-xs",
                        aiLandscapeStack === "top"
                          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                          : "border-zinc-200 dark:border-zinc-700",
                      ].join(" ")}
                      onClick={() => {
                        setAiLandscapeStack("top");
                        saveAiLayoutToStorage(undefined, { stack: "top" });
                      }}
                    >
                      {t("workspace.aiTop")}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className={[
                        "rounded-md border px-2 py-1 text-xs",
                        aiPanelSide === "right"
                          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                          : "border-zinc-200 dark:border-zinc-700",
                      ].join(" ")}
                      onClick={() => {
                        setAiPanelSide("right");
                        saveAiLayoutToStorage(undefined, { side: "right" });
                      }}
                    >
                      {t("workspace.aiRight")}
                    </button>
                    <button
                      type="button"
                      className={[
                        "rounded-md border px-2 py-1 text-xs",
                        aiPanelSide === "left"
                          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                          : "border-zinc-200 dark:border-zinc-700",
                      ].join(" ")}
                      onClick={() => {
                        setAiPanelSide("left");
                        saveAiLayoutToStorage(undefined, { side: "left" });
                      }}
                    >
                      {t("workspace.aiLeft")}
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </div>
          {activeMeta?.kind === "pdf" ? (
            <fieldset className="mt-2 space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
              <p className="text-xs text-zinc-500">{t("workspace.pdfScopeHint")}</p>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={pdfAskMode === "auto_material"}
                  onChange={() => setPdfAskMode("auto_material")}
                />
                {t("workspace.pdfScopeAuto")}
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={pdfAskMode === "force_current_page"}
                  onChange={() => setPdfAskMode("force_current_page")}
                />
                {t("workspace.pdfScopeForcePage")}
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={pdfAskMode === "force_full_document"}
                  onChange={() => setPdfAskMode("force_full_document")}
                />
                {t("workspace.pdfScopeForceFull")}
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={pdfAskMode === "current_page_plus_capture"}
                  onChange={() => setPdfAskMode("current_page_plus_capture")}
                />
                {t("workspace.pdfScopePagePlusCapture")}
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={pdfAskMode === "capture_only"}
                  onChange={() => setPdfAskMode("capture_only")}
                />
                {t("workspace.pdfScopeCaptureOnly")}
              </label>
            </fieldset>
          ) : activeMeta?.kind === "image" ? (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              {t("workspace.imageScopeHint")}
            </p>
          ) : activeMeta?.kind === "text" ? (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              {t("workspace.textScopeHint")}
            </p>
          ) : null}

          <textarea
            className="mt-3 w-full rounded-lg border border-zinc-200 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            rows={3}
            placeholder={t("workspace.questionPlaceholder")}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !activeMeta}
              onClick={() => void submitQuestion()}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {busy ? t("workspace.sending") : t("workspace.sendQuestion")}
            </button>
          </div>
          {error ? (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : null}
          {answer ? (
            <div className="mt-3 whitespace-pre-wrap break-words rounded-lg border border-zinc-100 bg-zinc-50 p-3 font-sans text-sm leading-relaxed text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
              {answer}
            </div>
          ) : null}
        </section>
        ) : null}

        {viewerFullscreen && !fullscreenAiOpen ? (
          <>
            <button
              type="button"
              aria-label={t("workspace.openAiPanel")}
              className={[
                "fixed z-[60] rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 shadow-md dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100",
                aiLayoutVerticalStack
                  ? "bottom-6 left-1/2 hidden -translate-x-1/2 md:block"
                  : "bottom-6 left-1/2 -translate-x-1/2 md:hidden",
              ].join(" ")}
              onClick={() => setFullscreenAiOpen(true)}
            >
              {t("workspace.aiShow")}
            </button>
            <button
              type="button"
              aria-label={t("workspace.openAiPanel")}
              className={[
                "fixed z-[60] rounded-l-lg border border-r-0 border-zinc-300 bg-white px-2 py-6 text-sm font-medium text-zinc-800 shadow-md dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100",
                aiLayoutVerticalStack
                  ? "hidden"
                  : "right-0 top-1/2 hidden -translate-y-1/2 md:block",
              ].join(" ")}
              onClick={() => setFullscreenAiOpen(true)}
            >
              {t("workspace.aiFab")}
            </button>
          </>
        ) : null}
      </main>
    </div>
  );
}
