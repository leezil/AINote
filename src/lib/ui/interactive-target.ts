const INTERACTIVE_SELECTOR = [
  "button",
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "option",
  "optgroup",
  "a[href]",
  "[contenteditable='true']",
  "[role='button']",
  "[role='textbox']",
  "[role='combobox']",
  "[role='slider']",
  "[data-ainote-interactive]",
].join(",");

/** 버튼·입력 등 — 여기서는 텍스트 선택·드래그 허용 */
export function isInteractiveUiTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(INTERACTIVE_SELECTOR) !== null;
}

export function shouldBlockDocumentChromeGesture(target: EventTarget | null): boolean {
  return !isInteractiveUiTarget(target);
}
