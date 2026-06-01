"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/LocaleProvider";
import {
  clampZoomScale,
  computeRenderWidth,
  isDocumentSharpening,
  useFitDocumentWidth,
} from "@/lib/documents/zoomable-document";

type Props = {
  fileUrl: string;
  fetchHeaders: HeadersInit;
  maxWidthPx?: number;
  wideMode?: boolean;
  viewportScale?: number;
  committedScale?: number;
  remeasureKey?: string | number;
};

export function WorkspaceDocText({
  fileUrl,
  fetchHeaders,
  maxWidthPx = 8192,
  wideMode = false,
  viewportScale = 1,
  committedScale = 1,
  remeasureKey,
}: Props) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<"loading" | "text" | "error">("loading");
  const [body, setBody] = useState("");
  const { containerRef, fitWidth } = useFitDocumentWidth({
    maxWidthPx,
    wideMode,
    remeasureKey,
  });
  const renderWidth = computeRenderWidth(fitWidth, committedScale);
  const safeCommitted = clampZoomScale(committedScale);
  const sharpening = isDocumentSharpening(viewportScale, committedScale);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setBody("");
    void (async () => {
      try {
        const res = await fetch(fileUrl, { headers: fetchHeaders });
        const txt = await res.text();
        if (!cancelled) {
          setBody(txt);
          setPhase("text");
        }
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileUrl, fetchHeaders]);

  const display =
    phase === "loading"
      ? t("textPreview.loading")
      : phase === "error"
        ? t("textPreview.error")
        : body;

  return (
    <div
      ref={containerRef}
      className="ainote-no-select flex w-full justify-center bg-zinc-100/80 dark:bg-zinc-900/60"
    >
      <div className="relative" style={{ width: renderWidth }}>
        {sharpening ? (
          <span className="pointer-events-none absolute right-1 top-1 z-10 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
            {t("pdf.sharpening")}
          </span>
        ) : null}
        <pre
          className="select-none whitespace-pre-wrap break-words p-4 leading-relaxed text-zinc-800 dark:text-zinc-100"
          style={{
            width: renderWidth,
            fontSize: `${0.75 * safeCommitted}rem`,
          }}
        >
          {display}
        </pre>
      </div>
    </div>
  );
}
