import { randomUUID } from "node:crypto";
import type { StoredDocumentMeta } from "@/lib/storage/document-store";
import { getPdfPageCount } from "@/lib/documents/pdf-text";
import { inferKindFromMime, normalizeMime } from "@/lib/documents/mime";
import { MAX_UPLOAD_FILE_BYTES } from "@/lib/documents/upload-limits";

export class UploadValidationError extends Error {
  constructor(
    message: string,
    readonly code: "TOO_LARGE" | "UNSUPPORTED" | "INVALID",
  ) {
    super(message);
    this.name = "UploadValidationError";
  }
}

export function assertUploadSize(bytes: number): void {
  if (bytes > MAX_UPLOAD_FILE_BYTES) {
    throw new UploadValidationError("파일당 최대 50MB까지 업로드할 수 있습니다.", "TOO_LARGE");
  }
}

export async function buildDocumentMetaFromBuffer(
  buffer: Buffer,
  filename: string,
  declaredMime?: string | null,
  id: string = randomUUID(),
): Promise<StoredDocumentMeta> {
  assertUploadSize(buffer.byteLength);

  let mime = normalizeMime(filename, declaredMime);
  let kind = inferKindFromMime(mime);
  if (!kind && buffer.length >= 5) {
    const head = buffer.subarray(0, 5).toString("latin1");
    if (head.startsWith("%PDF-")) {
      mime = "application/pdf";
      kind = "pdf";
    }
  }
  if (!kind) {
    throw new UploadValidationError(
      "지원하지 않는 형식입니다. (pdf, 이미지, txt)",
      "UNSUPPORTED",
    );
  }

  let pageCount = 1;
  if (kind === "pdf") {
    try {
      pageCount = await getPdfPageCount(buffer);
    } catch (err) {
      console.error("[ainote] getPdfPageCount failed (using placeholder):", err);
      pageCount = 1;
    }
  }

  return {
    id,
    filename: filename || "upload",
    mime,
    kind,
    pageCount,
    bytes: buffer.byteLength,
    createdAt: new Date().toISOString(),
  };
}
