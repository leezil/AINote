"use client";

import { createContext, useContext } from "react";

/** ZoomPanSurface → 타일 PDF 등 문서 뷰어가 패닝·배율·뷰포트 크기를 구독 */
export type ZoomPanTransform = {
  scale: number;
  panX: number;
  panY: number;
  viewportWidth: number;
  viewportHeight: number;
};

const defaultTransform: ZoomPanTransform = {
  scale: 1,
  panX: 0,
  panY: 0,
  viewportWidth: 960,
  viewportHeight: 600,
};

export const ZoomPanTransformContext = createContext<ZoomPanTransform>(defaultTransform);

export function useZoomPanTransform(): ZoomPanTransform {
  return useContext(ZoomPanTransformContext);
}
