import type { Locale } from "@/lib/i18n/messages";
import { messagesByLocale, type MessageKey } from "@/lib/i18n/messages";

/** Known server / client error strings (Korean) → message keys for English UI */
const KO_ERROR_TO_KEY: Record<string, MessageKey> = {
  "업로드 실패": "workspace.errUploadFailed",
  "업로드에 실패했습니다.": "workspace.errUploadFailed",
  "질문을 입력하세요.": "workspace.errEnterQuestion",
  "문서를 선택하세요.": "workspace.errSelectDoc",
  "AI 요청 실패": "workspace.errAiFailed",
  "오류": "workspace.errGeneric",
  "캡처 영역이 준비되지 않았습니다.": "workspace.errCaptureNotReady",
  "문서 목록을 불러올 수 없습니다.": "api.docListFailed",
  "multipart/form-data 로 파일을 업로드하세요.": "api.multipartRequired",
  "file 필드가 필요합니다.": "api.fileFieldRequired",
  "지원하지 않는 형식입니다. (pdf, 이미지, txt)": "api.unsupportedFormat",
  "저장 용량 1GB 한도를 초과합니다. 기존 문서를 지워도 새 파일이 너무 크거나, 비울 수 없습니다.":
    "api.storageCapExceeded",
  "파일당 최대 50MB까지 업로드할 수 있습니다.": "api.fileTooLarge",
  "해당 파일은 PDF가 아닙니다.": "api.notPdf",
  "해당 파일은 텍스트 문서가 아닙니다.": "api.notText",
  "해당 파일은 이미지가 아닙니다.": "api.notImage",
  "파일을 읽을 수 없습니다.": "api.fileReadFailed",
  "페이지 번호가 범위를 벗어났습니다.": "api.pageOutOfRange",
  "문서를 찾을 수 없습니다. 새로고침 후 다시 업로드하거나 목록에서 문서를 다시 여세요.": "api.docNotFound",
};

const KO_DOC_MISSING_VERCEL_PREFIX = "문서를 서버에서 찾을 수 없습니다.";

function matchDocumentMissingVercelKo(msg: string): boolean {
  return msg.startsWith(KO_DOC_MISSING_VERCEL_PREFIX);
}

export function translateApiError(message: string, locale: Locale): string {
  if (locale === "ko") return message;
  const key = KO_ERROR_TO_KEY[message];
  if (key) return messagesByLocale.en[key];
  if (matchDocumentMissingVercelKo(message)) {
    return `${messagesByLocale.en["api.docNotFound"]} On Vercel, configure Blob storage (BLOB_READ_WRITE_TOKEN) so uploads persist across instances.`;
  }
  return message;
}
