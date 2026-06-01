/** 필기 좌표: 문서 콘텐츠 박스 대비 0~1 (레이아웃·전체화면·AI 패널과 무관) */

export type NormPoint = { x: number; y: number };

export type NormStroke = {
  color: string;
  /** 콘텐츠 너비 대비 굵기 (0~1) */
  width: number;
  points: NormPoint[];
};

const NORM_MAX = 1.001;

export function isLikelyNormalizedStrokes(strokes: NormStroke[]): boolean {
  if (strokes.length === 0) return true;
  for (const s of strokes) {
    if (s.width > 0.2) return false;
    for (const p of s.points) {
      if (p.x > NORM_MAX || p.y > NORM_MAX || p.x < -0.001 || p.y < -0.001) return false;
    }
  }
  return true;
}

/** 예전 CSS 픽셀 좌표 → 정규화 (현재 콘텐츠 크기 기준 근사 변환) */
export function migratePixelStrokesToNormalized(
  strokes: NormStroke[],
  contentW: number,
  contentH: number,
): NormStroke[] {
  const w = Math.max(1, contentW);
  const h = Math.max(1, contentH);
  return strokes.map((s) => ({
    color: s.color,
    width: s.width / w,
    points: s.points.map((p) => ({
      x: clamp01(p.x / w),
      y: clamp01(p.y / h),
    })),
  }));
}

export function ensureNormalizedStrokes(
  strokes: NormStroke[],
  contentW: number,
  contentH: number,
): NormStroke[] {
  if (isLikelyNormalizedStrokes(strokes)) return strokes;
  return migratePixelStrokesToNormalized(strokes, contentW, contentH);
}

export function normPointToPx(p: NormPoint, contentW: number, contentH: number): NormPoint {
  return { x: p.x * contentW, y: p.y * contentH };
}

export function pxPointToNorm(p: NormPoint, contentW: number, contentH: number): NormPoint {
  const w = Math.max(1, contentW);
  const h = Math.max(1, contentH);
  return { x: clamp01(p.x / w), y: clamp01(p.y / h) };
}

export function strokeWidthPx(widthNorm: number, contentW: number): number {
  return Math.max(0.4, widthNorm * Math.max(1, contentW));
}

export function strokeWidthNorm(widthPx: number, contentW: number): number {
  return widthPx / Math.max(1, contentW);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
