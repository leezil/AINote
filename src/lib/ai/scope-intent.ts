/**
 * 질문 문구만으로 PDF 자료 범위(현재 페이지 vs 전체)를 추정합니다.
 * UI에서 "강제"를 고르면 이 결과는 사용하지 않습니다.
 */
export type PdfMaterialIntent = "current_page" | "full_document";

const PAGE_MARKERS = [
  "현재 페이지",
  "이 페이지",
  "지금 페이지",
  "보고 있는 페이지",
  "이 화면",
  "지금 화면",
  "여기 나온",
  "화면에 나온",
  "지금 보는",
  "위에 나온",
  "아래에 나온",
];

const FULL_MARKERS = [
  "전체 요약",
  "문서 전체",
  "전체 내용",
  "모든 페이지",
  "전 페이지",
  "파일 전체",
  "전부 요약",
  "전체를",
  "모든 내용",
  "통째로",
  "한꺼번에",
  "싹 다",
  "문서의 모든",
  "페이지 전체",
  "다 페이지",
];

export function inferPdfMaterialIntentFromQuestion(question: string): PdfMaterialIntent {
  const q = question.trim();
  if (!q) return "current_page";

  const hasPage = PAGE_MARKERS.some((m) => q.includes(m));
  const hasFull = FULL_MARKERS.some((m) => q.includes(m));

  /** 둘 다 있으면 더 좁은 "현재 페이지" 우선 (요구사항: 현재 페이지 요청은 그 범위만) */
  if (hasPage && hasFull) return "current_page";
  if (hasPage) return "current_page";
  if (hasFull) return "full_document";

  /** 명시 없으면 기본은 현재 페이지(토큰·범위 보수적) */
  return "current_page";
}
