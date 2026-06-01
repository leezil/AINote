"use client";

import { createContext, useContext } from "react";

/** ZoomPanSurface 뷰포트( transform 밖 )의 레이아웃 너비 — 문서 fitWidth 기준 */
export const ZoomPanViewportWidthContext = createContext(960);

export function useZoomPanViewportWidth(): number {
  return useContext(ZoomPanViewportWidthContext);
}
