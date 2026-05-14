/** 워크스페이스 업로드 파일 합산 상한 (바이트), 1 GiB */
export const WORKSPACE_STORAGE_CAP_BYTES = 1024 ** 3;

const AI_PURGE_AFTER_ASKS_DEFAULT = 500;
const AI_PURGE_AFTER_ASKS_MAX = 250_000;

/**
 * 성공한 AI 질문이 이 횟수마다 업로드 문서를 전부 삭제합니다.
 * Google AI Studio의 **일일 요청(RPD)** 한도와는 별개입니다.
 *
 * - `AINOTE_AI_PURGE_AFTER_SUCCESSFUL_ASKS` 환경 변수로 덮어씀 (기본 500).
 * - `0` / `never` / `off` 이면 **질문 횟수 기준 삭제는 하지 않음** (저장·1GB 정책은 그대로).
 */
export function getAiSuccessAskPurgeEvery(): number | null {
  const raw = process.env.AINOTE_AI_PURGE_AFTER_SUCCESSFUL_ASKS?.trim().toLowerCase();
  if (raw === undefined || raw === "") return AI_PURGE_AFTER_ASKS_DEFAULT;
  if (raw === "0" || raw === "never" || raw === "off" || raw === "false") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return AI_PURGE_AFTER_ASKS_DEFAULT;
  return Math.min(Math.floor(n), AI_PURGE_AFTER_ASKS_MAX);
}

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
