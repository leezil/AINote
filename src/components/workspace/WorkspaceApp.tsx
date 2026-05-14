"use client";

import dynamic from "next/dynamic";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toJpeg } from "html-to-image";
import type { StoredDocumentMeta } from "@/lib/storage/document-store";
import type { AskRequest } from "@/lib/ai/ask-schema";
import { InkOverlay, type InkOverlayHandle } from "@/components/ink/InkOverlay";

const PdfClientView = dynamic(
  () => import("@/components/pdf/PdfClientView").then((m) => m.PdfClientView),
  { ssr: false, loading: () => <p className="p-4 text-sm text-zinc-500">PDF 뷰어 로딩…</p> },
);

const defaultWorkspaceId =
  process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_ID?.trim() || "local";

type AskMode =
  | "pdf_page_text"
  | "pdf_page_text_plus_viewport"
  | "viewport_only"
  | "image_file"
  | "text_file";

export function WorkspaceApp() {
  const [documents, setDocuments] = useState<StoredDocumentMeta[]>([]);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pageByDoc, setPageByDoc] = useState<Record<string, number>>({});
  const captureRef = useRef<HTMLDivElement | null>(null);
  const inkRef = useRef<InkOverlayHandle | null>(null);

  const [question, setQuestion] = useState("");
  const [askMode, setAskMode] = useState<AskMode>("pdf_page_text");
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const activeMeta = useMemo(
    () => documents.find((d) => d.id === activeId) ?? null,
    [documents, activeId],
  );

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
      if (kind === "image") setAskMode("image_file");
      else if (kind === "text") setAskMode("text_file");
      else setAskMode("pdf_page_text");
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
      if (meta?.kind === "image") setAskMode("image_file");
      else if (meta?.kind === "text") setAskMode("text_file");
      else setAskMode("pdf_page_text");
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
        if (askMode === "pdf_page_text") {
          body = {
            question: q,
            scope: {
              kind: "pdf_page_text",
              documentId: activeMeta.id,
              page: currentPage,
            },
          };
        } else if (askMode === "pdf_page_text_plus_viewport") {
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
        } else if (askMode === "viewport_only") {
          const dataUrl = await captureViewportJpeg();
          body = {
            question: q,
            scope: {
              kind: "viewport_only",
              viewportImageBase64: dataUrl,
              viewportMimeType: "image/jpeg",
            },
          };
        } else {
          setError("PDF에 맞는 질문 범위를 선택하세요.");
          return;
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
    <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-3 p-3 md:flex-row md:gap-4 md:p-4">
      <aside className="flex w-full shrink-0 flex-col gap-2 md:w-56">
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

      <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
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
                  {currentPage} / {activeMeta.pageCount}
                </span>
                <button
                  type="button"
                  className="rounded-md border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
                  onClick={() =>
                    setPage(Math.min(activeMeta.pageCount, currentPage + 1))
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
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                className="rounded-md border border-zinc-200 px-2 py-1 text-sm dark:border-zinc-700"
                onClick={() => inkRef.current?.clear()}
              >
                필기 지우기
              </button>
            </div>
          </header>

          <div className="relative min-h-[320px] flex-1 overflow-auto bg-zinc-50 dark:bg-zinc-900/40">
            {!activeMeta ? (
              <p className="p-6 text-sm text-zinc-500">왼쪽에서 파일을 업로드하고 탭을 선택하세요.</p>
            ) : (
              <div ref={captureRef} className="relative min-h-[480px] w-full">
                {activeMeta.kind === "pdf" ? (
                  <PdfClientView
                    fileUrl={fileUrl}
                    pageNumber={currentPage}
                    maxWidthPx={920}
                  />
                ) : activeMeta.kind === "image" ? (
                  <div className="flex justify-center p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={fileUrl}
                      alt={activeMeta.filename}
                      className="max-h-[70vh] w-auto max-w-full object-contain"
                    />
                  </div>
                ) : (
                  <TextPreview fileUrl={fileUrl} fetchHeaders={workspaceHeaders} />
                )}
                <InkOverlay
                  ref={inkRef}
                  storageKey={inkStorageKey}
                  className="pointer-events-auto absolute inset-0 z-10"
                />
              </div>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100">AI 질문 (버튼을 누를 때만 호출)</p>
          {activeMeta?.kind === "pdf" ? (
            <fieldset className="mt-2 space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={askMode === "pdf_page_text"}
                  onChange={() => setAskMode("pdf_page_text")}
                />
                현재 페이지 텍스트만 (토큰 절약)
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={askMode === "pdf_page_text_plus_viewport"}
                  onChange={() => setAskMode("pdf_page_text_plus_viewport")}
                />
                현재 페이지 텍스트 + 화면 캡처(필기·도표 포함)
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={askMode === "viewport_only"}
                  onChange={() => setAskMode("viewport_only")}
                />
                화면 캡처만 (이미지 기반)
              </label>
            </fieldset>
          ) : activeMeta?.kind === "image" ? (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              범위: 업로드한 이미지 파일 전체 (서버에서만 읽어 전달, 클라이언트 재업로드 없음)
            </p>
          ) : activeMeta?.kind === "text" ? (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              범위: 텍스트 파일 본문 (길면 서버에서 잘라 전달)
            </p>
          ) : null}

          <textarea
            className="mt-3 w-full rounded-lg border border-zinc-200 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            rows={3}
            placeholder="예: 현재 페이지에 나온 정의를 한 문장으로 정리해줘"
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
            <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm leading-relaxed text-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
              {answer}
            </div>
          ) : null}
        </section>
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
