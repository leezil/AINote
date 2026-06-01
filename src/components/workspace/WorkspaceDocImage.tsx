"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/LocaleProvider";
import {
  computeRenderWidth,
  isDocumentSharpening,
  useFitDocumentWidth,
} from "@/lib/documents/zoomable-document";

type Props = {
  fileUrl: string;
  fetchHeaders: HeadersInit;
  alt: string;
  maxWidthPx?: number;
  wideMode?: boolean;
  viewportScale?: number;
  committedScale?: number;
};

/**
 * fetch + Blob URL로 헤더를 적용하고,
 * PDF와 같이 `fitWidth * committedScale` 로 표시 너비를 맞춥니다.
 */
export function WorkspaceDocImage({
  fileUrl,
  fetchHeaders,
  alt,
  maxWidthPx = 8192,
  wideMode = false,
  viewportScale = 1,
  committedScale = 1,
}: Props) {
  const { t } = useI18n();
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { fitWidth } = useFitDocumentWidth({ maxWidthPx, wideMode });
  const renderWidth = computeRenderWidth(fitWidth, committedScale);
  const sharpening = isDocumentSharpening(viewportScale, committedScale);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setBlobSrc(null);
    setFailed(false);

    void (async () => {
      try {
        const res = await fetch(fileUrl, { headers: fetchHeaders });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobSrc(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileUrl, fetchHeaders]);

  if (failed) {
    return (
      <p className="p-4 text-sm text-red-600 dark:text-red-400">{t("workspace.imageLoadError")}</p>
    );
  }
  if (!blobSrc) {
    return <p className="p-4 text-sm text-zinc-500">{t("textPreview.loading")}</p>;
  }

  return (
    <div className="ainote-no-select flex w-full min-w-0 justify-center bg-zinc-100/80 dark:bg-zinc-900/60">
      <div className="relative" style={{ width: renderWidth }}>
        {sharpening ? (
          <span className="pointer-events-none absolute right-1 top-1 z-10 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
            {t("pdf.sharpening")}
          </span>
        ) : null}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={blobSrc}
          alt={alt}
          className="block h-auto max-w-none select-none"
          style={{ width: renderWidth }}
          draggable={false}
        />
      </div>
    </div>
  );
}
