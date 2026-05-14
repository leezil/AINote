"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/LocaleProvider";

type Props = {
  fileUrl: string;
  fetchHeaders: HeadersInit;
  alt: string;
  className?: string;
};

/**
 * `<img src="/api/...">`는 커스텀 헤더를 붙일 수 없어, 워크스페이스가 헤더에 의존할 때 깨질 수 있음.
 * fetch + Blob URL로 동일 헤더를 적용한다.
 */
export function WorkspaceDocImage({ fileUrl, fetchHeaders, alt, className }: Props) {
  const { t } = useI18n();
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setBlobSrc(null);
    setFailed(false);

    (async () => {
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
    return <p className="p-4 text-sm text-red-600 dark:text-red-400">{t("workspace.imageLoadError")}</p>;
  }
  if (!blobSrc) {
    return <p className="p-4 text-sm text-zinc-500">{t("textPreview.loading")}</p>;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={blobSrc} alt={alt} className={className} />
  );
}
