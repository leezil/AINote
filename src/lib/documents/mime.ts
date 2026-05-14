import type { StoredDocumentKind } from "@/lib/storage/document-store";

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);

export function inferKindFromMime(mime: string): StoredDocumentKind | null {
  const m = mime.toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("text/")) return "text";
  if (IMAGE_MIMES.has(m)) return "image";
  return null;
}

export function normalizeMime(filename: string, declared?: string | null): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (declared && declared.length > 0) return declared;
  if (ext === "pdf") return "application/pdf";
  if (ext === "txt") return "text/plain";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}
