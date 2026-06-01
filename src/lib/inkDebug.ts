/**
 * 필기 디버그: 콘솔에 포인터 분기·상태를 남김.
 *
 * 켜는 방법(하나면 됨):
 * - 주소에 `?inkDebug=1` 붙이고 새로고침
 * - 콘솔에서 `localStorage.setItem('ainote_ink_debug','1')` 후 새로고침
 * - 콘솔에서 `window.__AINOTE_INK_DEBUG__ = true` (같은 탭에서 즉시 반영)
 *
 * 로그는 `console.info`로 남깁니다. Chrome에서 `console.debug`는 기본 필터에서 안 보일 수 있습니다.
 */

export function readInkDebugFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const w = window as Window & { __AINOTE_INK_DEBUG__?: boolean };
    if (w.__AINOTE_INK_DEBUG__ === true) return true;
    if (window.localStorage.getItem("ainote_ink_debug") === "1") return true;
    return new URLSearchParams(window.location.search).get("inkDebug") === "1";
  } catch {
    return false;
  }
}

export function inkDebugLog(phase: string, data: Record<string, unknown>): void {
  if (!readInkDebugFlag()) return;
  // console.debug는 DevTools 기본 레벨에서 숨겨지는 경우가 많아 info 사용
  console.info(`[ainote:ink] ${phase}`, data);
}

/** DOM PointerEvent에서 필기 추적에 쓰는 공통 필드 */
export function inkPointerDiagnostics(e: {
  pointerId: number;
  pointerType: string;
  width: number;
  height: number;
  pressure: number;
  isPrimary: boolean;
  button: number;
  buttons: number;
  clientX: number;
  clientY: number;
}): Record<string, unknown> {
  const pe = e as PointerEvent;
  return {
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    width: e.width,
    height: e.height,
    pressure: e.pressure,
    isPrimary: e.isPrimary,
    button: e.button,
    buttons: e.buttons,
    clientX: e.clientX,
    clientY: e.clientY,
    tiltX: typeof pe.tiltX === "number" ? pe.tiltX : undefined,
    tiltY: typeof pe.tiltY === "number" ? pe.tiltY : undefined,
    tangentialPressure:
      typeof pe.tangentialPressure === "number" ? pe.tangentialPressure : undefined,
  };
}

/**
 * 일부 기기·브라우저에서 Apple Pencil 등이 pointerType "touch"로 옴.
 * 손가락은 보통 더 큰 width/height; 스타일러스는 좁은 접촉면·압력이 붙는 경우가 많음.
 * (완벽하지 않음 — 디버그 로그로 width/height/pressure 확인 권장)
 */
export function isLikelyStylusAsTouch(e: {
  pointerType: string;
  width: number;
  height: number;
  pressure: number;
}): boolean {
  if (String(e.pointerType) !== "touch") return false;
  const w = Number(e.width) || 0;
  const h = Number(e.height) || 0;
  const p = Number(e.pressure) || 0;
  const maxWH = Math.max(w, h);
  if (w > 0 && h > 0 && maxWH <= 6) return true;
  if (p > 0.04 && w > 0 && h > 0 && maxWH <= 36) return true;
  return false;
}

/**
 * 손바닥·손날 등 넓은 접촉면 touch. (펜 필기 중 손을 대는 경우)
 * `width`/`height`는 CSS px 기준 PointerEvent.contact geometry.
 */
export function isLikelyPalmTouch(e: {
  pointerType: string;
  width: number;
  height: number;
}): boolean {
  if (String(e.pointerType) !== "touch") return false;
  const w = Number(e.width) || 0;
  const h = Number(e.height) || 0;
  if (w <= 0 || h <= 0) return false;
  const maxWH = Math.max(w, h);
  if (maxWH >= 28) return true;
  if (w * h >= 420) return true;
  return false;
}

/** 펜·스타일러스 포인터인지 (touch가 아닌 pen, 또는 touch-as-stylus 휴리스틱) */
export function isPenLikePointer(e: {
  pointerType: string;
  width: number;
  height: number;
  pressure: number;
}): boolean {
  const pt = String(e.pointerType);
  if (pt === "pen" || pt === "") return true;
  if (pt === "touch") return isLikelyStylusAsTouch(e);
  return false;
}
