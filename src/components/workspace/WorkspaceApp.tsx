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
import { InkOverlay, type InkOverlayHandle } from "@/components/ink/InkOverlay";
import { ZoomPanSurface } from "@/components/workspace/ZoomPanSurface";

const PdfClientView = dynamic(
  () => import("@/components/pdf/PdfClientView").then((m) => m.PdfClientView),
  { ssr: false, loading: () => <p className="p-4 text-sm text-zinc-500">PDF 뷰어 로딩…</p> },
);

const defaultWorkspaceId =
  process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_ID?.trim() || "local";

const FULLSCREEN_AI_WIDTH_KEY = "ainote:fullscreenAiWidth";

type PdfAskMode =
  | "auto_material"
  | "force_current_page"
  | "force_full_document"
  | "current_page_plus_capture"
  | "capture_only";

export function WorkspaceApp() {
  const [documents, setDocuments] = useState<StoredDocumentMeta[]>([]);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pageByDoc, setPageByDoc] = useState<Record<string, number>>({});
  /** react-pdf가 알려준 실제 페이지 수(문서 id별). 서버 pageCount가 1로만 올 때 보정. */
  const [pdfNumPagesByDoc, setPdfNumPagesByDoc] = useState<Record<string, number>>({});
  const captureRef = useRef<HTMLDivElement | null>(null);
  const inkRef = useRef<InkOverlayHandle | null>(null);

  const [question, setQuestion] = useState("");
  const [pdfAskMode, setPdfAskMode] = useState<PdfAskMode>("auto_material");
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 문서 뷰어를 뷰포트에 고정하고 AI 패널을 우측(가로) 또는 하단(세로)에 둠 */
  const [viewerFullscreen, setViewerFullscreen] = useState(false);
  /** true: 필기 / false: 확대·축소·이동(캡처 영역은 동일) */
  const [gestureInk, setGestureInk] = useState(true);
  /** 전체화면에서 AI 패널 표시 (가로 레이아웃에서 토글·리사이즈 대상) */
  const [fullscreenAiOpen, setFullscreenAiOpen] = useState(true);
  const [aiPanelWidthPx, setAiPanelWidthPx] = useState(380);
  const [isMdUp, setIsMdUp] = useState(false);
  /** 손가락(touch)으로도 필기 — 기본은 펜·마우스만 */
  const [allowFingerInk, setAllowFingerInk] = useState(false);
  const aiResizeRef = useRef<{ startX: number; startW: number } | null>(null);
  /** 이동·확대 모드에서 CSS scale — PDF 캔버스 DPR 보정에 사용 */
  const [viewerZoomScale, setViewerZoomScale] = useState(1);

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
      const raw = sessionStorage.getItem(FULLSCREEN_AI_WIDTH_KEY);
      if (!raw) return;
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 260 && n <= 1200) setAiPanelWidthPx(n);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsMdUp(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const clampAiPanelWidth = useCallback((w: number) => {
    const maxW = Math.min(Math.floor(window.innerWidth * 0.58), 720);
    return Math.min(maxW, Math.max(260, w));
  }, []);

  const onAiDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    aiResizeRef.current = { startX: e.clientX, startW: aiPanelWidthPx };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  };

  const onAiDividerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = aiResizeRef.current;
    if (!s) return;
    setAiPanelWidthPx(clampAiPanelWidth(s.startW + (e.clientX - s.startX)));
  };

  const onAiDividerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = aiResizeRef.current;
    aiResizeRef.current = null;
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (!s) return;
    const next = clampAiPanelWidth(s.startW + (e.clientX - s.startX));
    setAiPanelWidthPx(next);
    try {
      sessionStorage.setItem(FULLSCREEN_AI_WIDTH_KEY, String(next));
    } catch {
      // ignore
    }
  };

  const activeMeta = useMemo(
    () => documents.find((d) => d.id === activeId) ?? null,
    [documents, activeId],
  );

  const pdfPageTotal =
    activeMeta?.kind === "pdf" && activeMeta.id
      ? pdfNumPagesByDoc[activeMeta.id] ?? activeMeta.pageCount
      : activeMeta?.pageCount ?? 1;

  const currentPage = activeId ? pageByDoc[activeId] ?? 1 : 1;

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

  const onUpload: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/documents", {
      method: "POST",
      body: fd,
      headers: workspaceHeaders,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setError(typeof err.error === "string" ? err.error : "업로드 실패");
      return;
    }
    const data = (await res.json()) as { document: StoredDocumentMeta };
    await refreshDocuments();
    openDocument(data.document.id, { kind: data.document.kind });
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
    if (!node) throw new Error("캡처 영역이 준비되지 않았습니다.");
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
      setError("질문을 입력하세요.");
      return;
    }
    if (!activeMeta) {
      setError("문서를 선택하세요.");
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
        setError(typeof payload.error === "string" ? payload.error : "AI 요청 실패");
        return;
      }
      setAnswer(typeof payload.answer === "string" ? payload.answer : "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "오류");
    } finally {
      setBusy(false);
    }
  };

  const fileUrl = activeMeta
    ? `/api/documents/${activeMeta.id}/file`
    : "";

  const inkStorageKey = activeMeta
    ? `ainote:ink:${defaultWorkspaceId}:${activeMeta.id}`
    : "ainote:ink:none";

  return (
    <div
      className={[
        "mx-auto flex min-h-0 w-full flex-1",
        viewerFullscreen
          ? "max-w-none flex-col p-0"
          : "max-w-6xl flex-col gap-3 p-3 md:flex-row md:gap-4 md:p-4",
      ].join(" ")}
    >
      <aside
        className={[
          viewerFullscreen ? "hidden" : "flex",
          "w-full shrink-0 flex-col gap-2 md:w-56",
        ].join(" ")}
      >
        <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs font-medium text-zinc-500">자료</p>
          <label className="mt-2 flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-2 py-3 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800">
            <input type="file" className="hidden" accept=".pdf,image/*,.txt" onChange={onUpload} />
            업로드 (PDF / 이미지 / txt)
          </label>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="px-2 pb-1 text-xs font-medium text-zinc-500">저장된 문서</p>
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
              <li className="px-2 py-2 text-zinc-500">없음</li>
            ) : null}
          </ul>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="px-2 pb-1 text-xs font-medium text-zinc-500">열린 탭</p>
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
              <li className="px-2 py-2 text-sm text-zinc-500">문서를 업로드하세요.</li>
            ) : null}
          </ul>
        </div>
      </aside>

      <main
        className={[
          "flex min-h-0 min-w-0 flex-1",
          viewerFullscreen
            ? "fixed inset-0 z-50 m-0 h-[100dvh] max-w-none flex-col bg-white p-0 dark:bg-zinc-950 md:flex-row md:gap-0"
            : "flex-col gap-3",
        ].join(" ")}
      >
        <section
          className={[
            "flex min-h-0 flex-col overflow-hidden border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950",
            viewerFullscreen
              ? "min-h-0 flex-1 rounded-none border-0 shadow-none md:min-h-0"
              : "flex-1 rounded-xl",
          ].join(" ")}
        >
          <header className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
            {activeMeta?.kind === "pdf" ? (
              <>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
                  onClick={() => setPage(Math.max(1, currentPage - 1))}
                >
                  이전
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
                  다음
                </button>
              </>
            ) : (
              <span className="text-sm text-zinc-600 dark:text-zinc-300">
                {activeMeta?.filename ?? "문서 없음"}
              </span>
            )}
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
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
                필기
              </button>
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
                이동·확대
              </button>
              <button
                type="button"
                className="rounded-md border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
                onClick={() => inkRef.current?.clear()}
              >
                필기 지우기
              </button>
              {gestureInk ? (
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                  <input
                    type="checkbox"
                    className="rounded border-zinc-300 dark:border-zinc-600"
                    checked={allowFingerInk}
                    onChange={(e) => setAllowFingerInk(e.target.checked)}
                  />
                  손가락 필기
                </label>
              ) : null}
              {viewerFullscreen ? (
                fullscreenAiOpen ? (
                  <button
                    type="button"
                    className="rounded-md border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
                    onClick={() => setFullscreenAiOpen(false)}
                  >
                    AI 숨기기
                  </button>
                ) : (
                  <button
                    type="button"
                    className="rounded-md border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
                    onClick={() => setFullscreenAiOpen(true)}
                  >
                    AI 열기
                  </button>
                )
              ) : null}
              <button
                type="button"
                className="rounded-md border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
                onClick={() => setViewerFullscreen((v) => !v)}
              >
                {viewerFullscreen ? "전체화면 끄기" : "전체화면"}
              </button>
            </div>
          </header>

          <div
            className={[
              "relative bg-zinc-50 dark:bg-zinc-900/40",
              viewerFullscreen ? "min-h-0 flex-1 overflow-hidden" : "min-h-[320px] flex-1 overflow-auto",
            ].join(" ")}
          >
            {!activeMeta ? (
              <p className="p-6 text-sm text-zinc-500">왼쪽에서 파일을 업로드하고 탭을 선택하세요.</p>
            ) : (
              <ZoomPanSurface
                navigationMode={!gestureInk}
                className={viewerFullscreen ? "h-full min-h-0" : "min-h-[320px]"}
                onScaleChange={setViewerZoomScale}
                viewResetKey={
                  activeMeta
                    ? `${activeMeta.id}-${currentPage}-${viewerFullscreen ? 1 : 0}`
                    : "none"
                }
              >
                <div ref={captureRef} className="relative mx-auto min-h-[480px] w-max max-w-full">
                  {activeMeta.kind === "pdf" ? (
                    <PdfClientView
                      key={activeMeta.id}
                      fileUrl={fileUrl}
                      pageNumber={currentPage}
                      maxWidthPx={viewerFullscreen ? 8192 : 1280}
                      wideMode={viewerFullscreen}
                      viewportScale={viewerZoomScale}
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
                  ) : activeMeta.kind === "image" ? (
                    <div className="flex justify-center p-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={fileUrl}
                        alt={activeMeta.filename}
                        className="max-h-[85vh] w-auto max-w-none object-contain md:max-h-[90vh]"
                      />
                    </div>
                  ) : (
                    <TextPreview fileUrl={fileUrl} fetchHeaders={workspaceHeaders} />
                  )}
                  <InkOverlay
                    ref={inkRef}
                    storageKey={inkStorageKey}
                    allowFingerInk={allowFingerInk}
                    className={[
                      "absolute inset-0 z-10",
                      gestureInk ? "pointer-events-auto" : "pointer-events-none",
                    ].join(" ")}
                  />
                </div>
              </ZoomPanSurface>
            )}
          </div>
        </section>

        {viewerFullscreen && fullscreenAiOpen && isMdUp ? (
          <div
            role="separator"
            aria-label="AI 패널 너비 조절"
            aria-orientation="vertical"
            className="hidden shrink-0 cursor-col-resize touch-none select-none bg-zinc-200 hover:bg-zinc-400 dark:bg-zinc-700 dark:hover:bg-zinc-500 md:block md:w-1.5"
            onPointerDown={onAiDividerPointerDown}
            onPointerMove={onAiDividerPointerMove}
            onPointerUp={onAiDividerPointerUp}
            onPointerCancel={onAiDividerPointerUp}
          />
        ) : null}

        {(!viewerFullscreen || fullscreenAiOpen) ? (
        <section
          className={[
            "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950",
            viewerFullscreen
              ? "flex max-h-[42vh] min-h-0 shrink-0 flex-col overflow-y-auto border-t p-3 md:max-h-none md:shrink-0 md:border-l md:border-t-0 md:p-4"
              : "rounded-xl border p-3 shadow-sm",
          ].join(" ")}
          style={
            viewerFullscreen && fullscreenAiOpen && isMdUp
              ? { width: aiPanelWidthPx, minWidth: 260, maxWidth: "min(58vw, 720px)" }
              : undefined
          }
        >
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100">AI 질문 (버튼을 누를 때만 호출)</p>
          {activeMeta?.kind === "pdf" ? (
            <fieldset className="mt-2 space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
              <p className="text-xs text-zinc-500">
                「자동」: 질문에 &quot;전체 요약&quot;·&quot;모든 페이지&quot; 등이 있으면 문서 전체 텍스트,
                &quot;현재 페이지&quot;·&quot;이 화면&quot; 등이 있으면 보고 있는 페이지만 전달합니다. (둘 다 없으면
                현재 페이지) 교재처럼 <strong className="font-medium text-zinc-600 dark:text-zinc-400">스캔 PDF</strong>
                는 텍스트 레이어가 없어 추출이 비는 경우가 많습니다. 그때는 아래{' '}
                <strong className="font-medium text-zinc-600 dark:text-zinc-400">
                  화면 캡처 포함
                </strong>
                모드를 쓰면 이미지로 문제를 보낼 수 있습니다.
              </p>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={pdfAskMode === "auto_material"}
                  onChange={() => setPdfAskMode("auto_material")}
                />
                자동 (질문 문구로 현재 페이지 vs 전체 판별)
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={pdfAskMode === "force_current_page"}
                  onChange={() => setPdfAskMode("force_current_page")}
                />
                강제: 지금 보는 페이지 텍스트만
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={pdfAskMode === "force_full_document"}
                  onChange={() => setPdfAskMode("force_full_document")}
                />
                강제: PDF 전체 텍스트 (길면 서버에서 잘림)
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={pdfAskMode === "current_page_plus_capture"}
                  onChange={() => setPdfAskMode("current_page_plus_capture")}
                />
                현재 페이지 텍스트 + 화면 캡처 (필기·도표)
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={pdfAskMode === "capture_only"}
                  onChange={() => setPdfAskMode("capture_only")}
                />
                화면 캡처만 (이미지로 질문)
              </label>
            </fieldset>
          ) : activeMeta?.kind === "image" ? (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              범위: 업로드한 이미지 파일 전체를 서버가 Gemini에 전달합니다. (표·손글씨·사진 인식 가능)
            </p>
          ) : activeMeta?.kind === "text" ? (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              범위: 텍스트 파일 본문 (길면 서버에서 잘라 전달)
            </p>
          ) : null}

          <textarea
            className="mt-3 w-full rounded-lg border border-zinc-200 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            rows={3}
            placeholder='예: "현재 페이지" 정의만 정리해줘 / "전체 요약" 해줘'
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
              {busy ? "처리 중…" : "질문 보내기"}
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
              aria-label="AI 패널 열기"
              className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 shadow-md dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 md:hidden"
              onClick={() => setFullscreenAiOpen(true)}
            >
              AI 열기
            </button>
            <button
              type="button"
              aria-label="AI 패널 열기"
              className="fixed right-0 top-1/2 z-[60] hidden -translate-y-1/2 rounded-l-lg border border-r-0 border-zinc-300 bg-white px-2 py-6 text-sm font-medium text-zinc-800 shadow-md dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 md:block"
              onClick={() => setFullscreenAiOpen(true)}
            >
              AI
            </button>
          </>
        ) : null}
      </main>
    </div>
  );
}

function TextPreview({
  fileUrl,
  fetchHeaders,
}: {
  fileUrl: string;
  fetchHeaders: Record<string, string>;
}) {
  const [text, setText] = useState<string>("불러오는 중…");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(fileUrl, { headers: fetchHeaders });
        const t = await res.text();
        if (!cancelled) setText(t);
      } catch {
        if (!cancelled) setText("텍스트를 불러올 수 없습니다.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileUrl, fetchHeaders]);
  return (
    <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words p-4 text-xs leading-relaxed text-zinc-800 dark:text-zinc-100">
      {text}
    </pre>
  );
}
