/** 워크스페이스 업로드 파일 합산 상한 (바이트), 1 GiB */
export const WORKSPACE_STORAGE_CAP_BYTES = 1024 ** 3;

/** AI 질문이 서버에서 성공한 횟수가 이 값에 도달하면 저장된 문서를 모두 삭제합니다. */
export const AI_SUCCESS_ASK_PURGE_EVERY = 10;

export function totalBytesOfDocuments(docs: Array<{ bytes: number }>): number {
  return docs.reduce((s, d) => s + (typeof d.bytes === "number" ? d.bytes : 0), 0);
}

export function sortDocumentsOldestFirst<T extends { createdAt: string }>(docs: T[]): T[] {
  return [...docs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function readAiAskCountFromParsedJson(parsed: unknown): number {
  if (!parsed || typeof parsed !== "object") return 0;
  const c = (parsed as { aiAskCount?: unknown }).aiAskCount;
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0) return 0;
  return Math.floor(c);
}
