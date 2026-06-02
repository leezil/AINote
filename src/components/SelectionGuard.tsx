"use client";

import type { ReactNode } from "react";
import { useBlockNonInteractiveSelection } from "@/hooks/useBlockNonInteractiveSelection";

type Props = {
  children: ReactNode;
};

/** 앱 전역: 버튼·입력만 선택 가능, 나머지는 선택·드래그 불가 */
export function SelectionGuard({ children }: Props) {
  useBlockNonInteractiveSelection(true);

  return <div className="ainote-app-shell flex min-h-full flex-1 flex-col">{children}</div>;
}
