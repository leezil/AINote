import { upload } from "@vercel/blob/client";
import type { StoredDocumentMeta } from "@/lib/storage/document-store";
import {
  DIRECT_UPLOAD_SAFE_BYTES,
  MAX_UPLOAD_FILE_BYTES,
} from "@/lib/documents/upload-limits";
import { blobFilePathname } from "@/lib/storage/workspace-id";

export type UploadConfig = {
  maxFileBytes: number;
  directUploadMaxBytes: number;
  useClientBlobUpload: boolean;
  blobAccess: "public" | "private";
};

export function assertClientUploadSize(bytes: number): void {
  if (bytes > MAX_UPLOAD_FILE_BYTES) {
    throw new Error("파일당 최대 50MB까지 업로드할 수 있습니다.");
  }
}

export async function fetchUploadConfig(): Promise<UploadConfig> {
  const res = await fetch("/api/documents/upload-config", { cache: "no-store" });
  if (!res.ok) {
    return {
      maxFileBytes: MAX_UPLOAD_FILE_BYTES,
      directUploadMaxBytes: DIRECT_UPLOAD_SAFE_BYTES,
      useClientBlobUpload: false,
      blobAccess: "private",
    };
  }
  return (await res.json()) as UploadConfig;
}

export async function uploadDocumentFile(
  file: File,
  workspaceId: string,
  workspaceHeaders: Record<string, string>,
  config: UploadConfig,
): Promise<StoredDocumentMeta> {
  assertClientUploadSize(file.size);

  const useBlob =
    config.useClientBlobUpload && file.size > config.directUploadMaxBytes;

  if (useBlob) {
    const documentId = crypto.randomUUID();
    const pathname = blobFilePathname(workspaceId, documentId);
    const blob = await upload(pathname, file, {
      access: config.blobAccess,
      handleUploadUrl: "/api/documents/blob-upload",
      headers: workspaceHeaders,
      multipart: file.size > 4_500_000,
      contentType: file.type || undefined,
    });

    const res = await fetch("/api/documents/register", {
      method: "POST",
      headers: { ...workspaceHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        documentId,
        filename: file.name,
        blobUrl: blob.url,
        bytes: file.size,
        mime: file.type,
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(typeof err.error === "string" ? err.error : "업로드 등록에 실패했습니다.");
    }
    const data = (await res.json()) as { document: StoredDocumentMeta };
    return data.document;
  }

  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/documents", {
    method: "POST",
    body: fd,
    headers: workspaceHeaders,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 413 && !err.error) {
    throw new Error("파일당 최대 50MB까지 업로드할 수 있습니다.");
    }
    throw new Error(typeof err.error === "string" ? err.error : "업로드에 실패했습니다.");
  }
  const data = (await res.json()) as { document: StoredDocumentMeta };
  return data.document;
}
