"use client";

import { useEffect } from "react";
import { shouldBlockDocumentChromeGesture } from "@/lib/ui/interactive-target";

/**
 * 버튼·입력을 제외한 영역에서 텍스트 선택·드래그·길게누르기 메뉴를 막습니다.
 * (필기·패닝 중 UI 문자열이 선택되는 현상 방지)
 */
export function useBlockNonInteractiveSelection(enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const block = (e: Event) => {
      if (!shouldBlockDocumentChromeGesture(e.target)) return;
      e.preventDefault();
    };

    const blockMultiClickSelect = (e: MouseEvent) => {
      if (!shouldBlockDocumentChromeGesture(e.target)) return;
      if (e.detail > 1) e.preventDefault();
    };

    document.addEventListener("selectstart", block, true);
    document.addEventListener("dragstart", block, true);
    document.addEventListener("contextmenu", block, true);
    document.addEventListener("mousedown", blockMultiClickSelect, true);

    return () => {
      document.removeEventListener("selectstart", block, true);
      document.removeEventListener("dragstart", block, true);
      document.removeEventListener("contextmenu", block, true);
      document.removeEventListener("mousedown", blockMultiClickSelect, true);
    };
  }, [enabled]);
}
