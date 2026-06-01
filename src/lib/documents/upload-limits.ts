/** 단일 파일 업로드 상한 (50 MiB) */
export const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;

/** Vercel Serverless 요청 body 한도(~4.5MB) 이하일 때만 API 경유 업로드 */
export const DIRECT_UPLOAD_SAFE_BYTES = 4_000_000;

export const MAX_UPLOAD_FILE_LABEL = "50MB";
